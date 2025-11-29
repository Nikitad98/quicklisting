import express from "express";
import cors from "cors";
import Stripe from "stripe";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

dotenv.config();
const app = express();
const port = process.env.PORT || 10000;

// --------------------
// INITIALIZE SERVICES
// --------------------
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Webhook requires raw body
app.use("/webhook", bodyParser.raw({ type: "application/json" }));

// Normal JSON for everything else
app.use(express.json());
app.use(cors());
app.use(cookieParser());

// -------------------------------
// DAILY FREE RESET AT MIDNIGHT
// -------------------------------
async function scheduleDailyReset() {
  const now = new Date();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);

  const delay = midnight - now;

  setTimeout(async () => {
    await redis.set("free_count", 10);
    console.log("🔄 Daily free count reset to 10");
    scheduleDailyReset();
  }, delay);
}
scheduleDailyReset();

// Make sure free count exists
redis.get("free_count").then((v) => {
  if (!v) redis.set("free_count", 10);
});

// -------------------------------
// CHECK USER PLAN + REMAINING
// -------------------------------
async function getUserCredits(userId) {
  const plan = (await redis.get(`plan:${userId}`)) || "free";

  if (plan === "starter") {
    let credits = await redis.get(`credits:${userId}`);
    if (credits === null) {
      await redis.set(`credits:${userId}`, 150);
      credits = 150;
    }
    return { plan, credits };
  }

  if (plan === "growth") {
    let credits = await redis.get(`credits:${userId}`);
    if (credits === null) {
      await redis.set(`credits:${userId}`, 500);
      credits = 500;
    }
    return { plan, credits };
  }

  const freeLeft = await redis.get("free_count");
  return { plan: "free", credits: freeLeft };
}

// -------------------------------
// GENERATION ENDPOINT
// -------------------------------
app.post("/generate", async (req, res) => {
  try {
    const userId = req.cookies.userId || req.headers["x-user-id"];

    if (!userId) return res.status(400).json({ error: "Missing userId" });

    // Admin unlimited mode
    if (userId === process.env.ADMIN_KEY) {
      return res.json({
        title: "Boss mode active",
        description: "Unlimited power.",
      });
    }

    const { plan, credits } = await getUserCredits(userId);

    if (credits <= 0) {
      return res.status(402).json({ error: "limit_reached", plan });
    }

    // Deduct credit
    if (plan === "free") {
      await redis.decr("free_count");
    } else {
      await redis.decr(`credits:${userId}`);
    }

    // ------- AI GENERATION -------
    const features = req.body.features || "";
    const tone = req.body.tone || "Professional";
    const length = req.body.length || "Short";
    const audience = req.body.audience || "Buyers";

    const prompt = `
Write a real estate listing title and description.
Features: ${features}
Tone: ${tone}, Length: ${length}, Audience: ${audience}.
`;

    const ai = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const json = await ai.json();

    return res.json({
      title: json.choices[0].message.content.split("\n")[0],
      description: json.choices[0].message.content,
    });
  } catch (err) {
    console.error("GEN ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// -------------------------------
// CHECKOUT SESSIONS
// -------------------------------
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, userId } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: process.env.STRIPE_SUCCESS_URL,
      cancel_url: process.env.STRIPE_CANCEL_URL,
      metadata: { userId, priceId },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("CHECKOUT ERROR:", err);
    res.status(500).json({ error: "checkout_failed" });
  }
});

// ---------------------------------------
// STRIPE WEBHOOK — REQUIRED FOR ACTIVATION
// ---------------------------------------
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    return res.status(400).send("Webhook signature failed");
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata.userId;
    const priceId = session.metadata.priceId;

    if (priceId === process.env.STRIPE_STARTER_PRICE_ID) {
      await redis.set(`plan:${userId}`, "starter");
      await redis.set(`credits:${userId}`, 150);
      console.log("🎉 Starter activated:", userId);
    }

    if (priceId === process.env.STRIPE_GROWTH_PRICE_ID) {
      await redis.set(`plan:${userId}`, "growth");
      await redis.set(`credits:${userId}`, 500);
      console.log("🚀 Growth activated:", userId);
    }
  }

  res.sendStatus(200);
});

// -------------------------------
// START SERVER
// -------------------------------
app.use(express.static("public"));

app.listen(port, () =>
  console.log(`QuickListing running on http://localhost:${port}`)
);
