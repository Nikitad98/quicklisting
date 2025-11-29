// -------------------------------------------------------------
// QuickListing — PRODUCTION BACKEND (Stripe + Redis + Usage)
// -------------------------------------------------------------
const path = require("path");
const express = require("express");
const { OpenAI } = require("openai");
const Stripe = require("stripe");
const { Redis } = require("@upstash/redis");
require("dotenv").config();

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf; // needed for stripe webhook signature
  }
}));
app.use(express.urlencoded({ extended: true }));

// -------------------------------------------------------------
// STATIC
// -------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_,res)=>res.sendFile(path.join(__dirname,"public","landing.html")));
app.get("/app",(_,res)=>res.sendFile(path.join(__dirname,"public","app.html")));
app.get("/upgrade",(_,res)=>res.sendFile(path.join(__dirname,"public","upgrade.html")));
app.get("/success",(_,res)=>res.sendFile(path.join(__dirname,"public","success.html")));

// Health
app.get("/version",(_,res)=>res.json({ok:true,version:"3.0.0"}));


// -------------------------------------------------------------
// REDIS
// -------------------------------------------------------------
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// plan caps
const CAPS = { free: 10, starter: 150, growth: 500 };

// helper
function monthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}`;
}


// -------------------------------------------------------------
// USAGE GUARD (Redis-based)
// -------------------------------------------------------------
async function usageGuard(req, res, next) {
  try {
    // Boss mode override
    const adminHeader = req.headers["x-admin-key"];
    const ADMIN_KEY = process.env.ADMIN_KEY || "";
    if (adminHeader && adminHeader === ADMIN_KEY) {
      res.setHeader("X-Plan","boss");
      res.setHeader("X-Remaining","INF");
      return next();
    }

    // userId (anonymous)
    let userId = (req.headers["x-user-id"] || "").toString().trim();
    if (!userId) {
      userId = req.ip || "unknown";
    }

    // real plan from Redis (Stripe-sync)
    const plan = (await redis.get(`ql:plan:${userId}`)) || "free";
    const limit = CAPS[plan] ?? CAPS.free;

    const month = monthKey();
    const key = `ql:usage:${userId}:${month}`;

    let record = await redis.get(key);
    let used = record?.used ?? 0;

    if (used >= limit) {
      res.setHeader("X-Plan", plan);
      res.setHeader("X-Remaining", 0);
      return res.status(402).json({
        error:`Limit reached for ${plan}`,
        plan, limit, used
      });
    }

    // increment + store
    used += 1;
    await redis.set(key, { used, plan, month, updatedAt: Date.now() });

    const remaining = Math.max(0, limit-used);
    res.setHeader("X-Plan", plan);
    res.setHeader("X-Remaining", remaining);

    next();
  } catch (err) {
    console.error("USAGE GUARD ERROR:", err);
    next(); // fail-open
  }
}


// -------------------------------------------------------------
// OPENAI
// -------------------------------------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/generate", usageGuard, async (req,res)=>{
  try {
    const { features="", tone="Professional", length="short", audience="Buyers" } = req.body;
    if (!features.trim()) return res.status(400).json({error:"Missing features"});

    const messages = [
      { role:"system", content:`You are a real-estate copywriter. Return JSON: { "meta": { "title": string, "bullets": string[] }, "description": string }.` },
      { role:"user", content:`Create a listing description.\n- Features: ${features}\n- Tone: ${tone}\n- Length: ${length}\n- Audience: ${audience}\n- Title: 4–9 words no emojis.\n- Bullets: 2–4 items.`}
    ];

    const resp = await openai.chat.completions.create({
      model:"gpt-4o-mini",
      messages,
      temperature:0.3,
      response_format:{ type:"json_object" }
    });

    let data;
    try { data = JSON.parse(resp.choices[0].message.content); }
    catch { data = {}; }

    const title = data?.meta?.title || "Beautiful Home";
    const bullets = Array.isArray(data?.meta?.bullets) ? data.meta.bullets.slice(0,4) : [];
    const description = data?.description || "Charming property description.";

    res.json({ meta:{title, bullets}, description });
  } catch (err) {
    console.error("GEN ERROR:", err);
    res.status(500).json({error:"Server error"});
  }
});


// -------------------------------------------------------------
// STRIPE CHECKOUT
// -------------------------------------------------------------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const STARTER_PRICE = "price_1SUjjT4RsMwSLTmtpamYSCca";
const GROWTH_PRICE  = "price_1SUjkD4RsMwSLTmttJmPB8dX";

app.post("/create-checkout-session", async (req,res)=>{
  try {
    const { plan, userId } = req.body;
    const normalized = (plan || "starter").toLowerCase();

    const priceId = normalized === "growth" ? GROWTH_PRICE : STARTER_PRICE;

    const session = await stripe.checkout.sessions.create({
      mode:"subscription",
      line_items:[{ price:priceId, quantity:1 }],
      success_url:`${process.env.STRIPE_SUCCESS_URL}?plan=${normalized}`,
      cancel_url: process.env.STRIPE_CANCEL_URL || "https://quicklisting.onrender.com/upgrade",
      metadata: {
        userId: userId || "unknown"
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("CHECKOUT ERROR:", err);
    res.status(500).json({ error:"stripe error" });
  }
});


// -------------------------------------------------------------
// STRIPE WEBHOOK — The REAL source of truth
// -------------------------------------------------------------
app.post("/stripe/webhook", (req,res)=>{
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("WEBHOOK SIGNATURE ERROR:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle events
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata.userId;
    const priceId = session.line_items?.data?.[0]?.price?.id || "";

    let plan = "free";
    if (priceId === STARTER_PRICE) plan = "starter";
    if (priceId === GROWTH_PRICE) plan = "growth";

    redis.set(`ql:plan:${userId}`, plan);
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const customerId = sub.customer;

    // find user by scanning Redis
    redis.set(`ql:plan:${customerId}`, "free");
  }

  res.json({received:true});
});


// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log("Server running on " + PORT));
