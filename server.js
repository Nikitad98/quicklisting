// server.js — QuickListing with Redis usage tracking
// -----------------------------------------------
const path = require("path");
const express = require("express");
const { OpenAI } = require("openai");
const Stripe = require("stripe");
const { Redis } = require("@upstash/redis");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Static assets ----------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// ---- Pages ------------------------------------------------------------------
app.get("/",       (_, res) => res.sendFile(path.join(__dirname, "public", "landing.html")));
app.get("/app",    (_, res) => res.sendFile(path.join(__dirname, "public", "app.html")));
app.get("/upgrade",(_, res) => res.sendFile(path.join(__dirname, "public", "upgrade.html")));
app.get("/success",(_, res) => res.sendFile(path.join(__dirname, "public", "success.html")));

// ---- Health -----------------------------------------------------------------
app.get("/version", (_, res) =>
  res.json({ ok: true, app: "QuickListing", version: "2.0.0" })
);

// ============================================================================
// Redis client (Upstash)
// ============================================================================
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Plan caps per month
const CAPS = { free: 10, starter: 150, growth: 500 };
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// Get month string like "2025-11"
function currentMonthKey() {
  const now = new Date();
  return (
    now.getUTCFullYear() +
    "-" +
    String(now.getUTCMonth() + 1).padStart(2, "0")
  );
}

// Read plan hint from header (still used for now)
function getPlan(req) {
  const p = (req.headers["x-plan"] || "").toString().toLowerCase().trim();
  return ["free", "starter", "growth"].includes(p) ? p : "free";
}

// ============================================================================
// Usage guard — checks Redis before /generate
// ============================================================================
async function usageGuard(req, res, next) {
  try {
    // Boss mode: skip limits
    const adminHeader = (req.headers["x-admin-key"] || "").toString().trim();
    const isBoss = ADMIN_KEY && adminHeader && adminHeader === ADMIN_KEY;
    if (isBoss) {
      res.setHeader("X-Plan", "boss");
      res.setHeader("X-Remaining", "INF");
      return next();
    }

    // User id (anonymous) from header; fallback to IP
    let userId = (req.headers["x-user-id"] || "").toString().trim();
    if (!userId) {
      userId =
        (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
        req.socket?.remoteAddress ||
        req.ip ||
        "unknown";
    }

    const plan = getPlan(req);
    const limit = CAPS[plan] ?? CAPS.free;
    const month = currentMonthKey();
    const key = `ql:usage:${userId}:${month}`;

    let record = await redis.get(key); // { used, plan, month } or null
    let used = record && typeof record.used === "number" ? record.used : 0;

    if (used >= limit) {
      res.setHeader("X-Plan", plan);
      res.setHeader("X-Remaining", 0);
      return res.status(402).json({
        error: `Limit reached for ${plan}. Please upgrade on /upgrade.`,
        plan,
        limit,
        used,
      });
    }

    // Increment and store
    used += 1;
    record = { used, plan, month, updatedAt: Date.now() };
    await redis.set(key, record);

    const remaining = Math.max(0, limit - used);
    res.setHeader("X-Plan", plan);
    res.setHeader("X-Remaining", remaining);

    return next();
  } catch (err) {
    console.error("USAGE GUARD ERROR:", err);
    // Fail-open: if Redis explodes, we don't block the user
    return next();
  }
}

// ============================================================================
// OpenAI client
// ============================================================================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ============================================================================
// /generate — protected by usageGuard
// ============================================================================
app.post("/generate", usageGuard, async (req, res) => {
  try {
    const {
      features = "",
      tone = "Professional",
      length = "short",
      audience = "Buyers",
    } = req.body || {};

    if (!features.trim()) {
      return res.status(400).json({ error: "Please provide key features." });
    }

    const system =
      'You are a real-estate copywriter. Return JSON: { "meta": { "title": string, "bullets": string[] }, "description": string }.';
    const user = `Create a listing description.
- Features: ${features}
- Tone: ${tone}
- Length: ${length}
- Audience: ${audience}
- Title: 4–9 words, no emojis.
- Bullets: 2–4 MLS-style bullets, concise.`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    let data;
    try {
      data = JSON.parse(resp.choices?.[0]?.message?.content || "{}");
    } catch {
      data = {};
    }

    const title = (data?.meta?.title || "Charming Move-In Ready Home")
      .toString()
      .slice(0, 80);
    const bullets = Array.isArray(data?.meta?.bullets)
      ? data.meta.bullets.slice(0, 4)
      : [];
    const description = (
      data?.description || "Well-presented home close to transit."
    ).toString();

    return res.json({ meta: { title, bullets }, description });
  } catch (e) {
    console.error("GENERATE ERROR:", e?.status, e?.code, e?.message);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

// ============================================================================
// Stripe Checkout — Starter / Growth
// ============================================================================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const STARTER_PRICE_ID = process.env.STRIPE_STARTER_PRICE_ID;
const GROWTH_PRICE_ID = process.env.STRIPE_GROWTH_PRICE_ID;
const SUCCESS_URL =
  process.env.STRIPE_SUCCESS_URL ||
  "https://quicklisting.onrender.com/success";
const CANCEL_URL =
  process.env.STRIPE_CANCEL_URL ||
  "https://quicklisting.onrender.com/upgrade";

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { plan } = req.body || {};
    const normalized = (plan || "starter").toLowerCase();
    const priceId =
      normalized === "growth" ? GROWTH_PRICE_ID : STARTER_PRICE_ID;

    if (!priceId) {
      return res.status(400).json({ error: "Unknown plan" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${SUCCESS_URL}?plan=${normalized}`,
      cancel_url: CANCEL_URL,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("STRIPE CHECKOUT ERROR:", err);
    return res.status(500).json({ error: "Unable to create checkout session" });
  }
});

// ----------------------------------------------------------------------------
// START
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`QuickListing running on http://localhost:${PORT}`)
);
