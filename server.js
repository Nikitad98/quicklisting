// server.js — QuickListing (Upstash Redis caps + Boss unlimited + Stripe Checkout)
// ---------------------------------------------------
const path = require("path");
const express = require("express");
const { OpenAI } = require("openai");
const Stripe = require("stripe");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Cookies (visitor id) --------------------------------------------------
app.use(cookieParser(process.env.COOKIE_SECRET || "ql_cookie_secret"));

function getVisitorId(req, res){
  let id = req.signedCookies?.ql_vid;
  if (!id) {
    id = crypto.randomUUID();
    res.cookie("ql_vid", id, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year
    });
  }
  return id;
}

// ---- Upstash Redis ---------------------------------------------------------
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ---- OpenAI ----------------------------------------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Stripe ----------------------------------------------------------------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const STARTER_PRICE_ID = process.env.STRIPE_STARTER_PRICE_ID;
const GROWTH_PRICE_ID  = process.env.STRIPE_GROWTH_PRICE_ID;

const SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || "http://localhost:3000/app";
const CANCEL_URL  = process.env.STRIPE_CANCEL_URL  || "http://localhost:3000/upgrade";

// ---- Static assets ----------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// ---- Pages ------------------------------------------------------------------
app.get("/",       (_,res)=>res.sendFile(path.join(__dirname,"public","landing.html")));
app.get("/app",    (_,res)=>res.sendFile(path.join(__dirname,"public","app.html")));
app.get("/upgrade",(_,res)=>res.sendFile(path.join(__dirname,"public","upgrade.html")));
app.get("/success",(_,res)=>res.sendFile(path.join(__dirname,"public","success.html")));

// ---- Health -----------------------------------------------------------------
app.get("/version",(_,res)=>res.json({ ok:true, app:"QuickListing", version:"1.2.0-boss-redis" }));

// ============================================================================
// Plan caps (persistent via Redis per visitor + Boss bypass)
// ============================================================================
// Plans: free → 10/mo, starter → 150/mo, growth → 500/mo
const CAPS = { free: 10, starter: 150, growth: 500 };

function getPlan(req){
  const p = (req.headers["x-plan"] || "free").toString().toLowerCase().trim();
  return ["free","starter","growth"].includes(p) ? p : "free";
}

// Count only /generate POST calls, once per month per visitor
// + Boss/admin bypass
app.use(async (req, res, next) => {
  if (req.path !== "/generate") return next();

  // ---------- Boss bypass ----------
  const adminKeyHeader = (req.headers["x-admin-key"] || "").toString().trim();
  if (adminKeyHeader && adminKeyHeader === process.env.ADMIN_KEY) {
    res.setHeader("X-Plan", "boss");
    res.setHeader("X-Remaining", "∞");
    return next();
  }
  // -------------------------------

  const visitorId = getVisitorId(req, res);
  const plan = getPlan(req);

  const now = new Date();
  const month = now.getUTCFullYear() + "-" + String(now.getUTCMonth()+1).padStart(2,"0");
  const limit = CAPS[plan];

  const key = `usage:${visitorId}`;

  let rec;
  try {
    rec = await redis.get(key);
  } catch (err) {
    console.error("Redis read error:", err?.message || err);
    rec = null;
  }

  if (!rec || typeof rec !== "object") rec = { month, plan, used: 0 };

  if (rec.month !== month) {
    rec.month = month;
    rec.used = 0;
  }

  rec.plan = plan;
  rec.used += 1;

  try {
    await redis.set(key, rec, { ex: 60 * 60 * 24 * 40 }); // ~40 days
  } catch (err) {
    console.error("Redis write error:", err?.message || err);
    // If Redis fails, allow temporarily instead of killing app.
    res.setHeader("X-Plan", plan);
    res.setHeader("X-Remaining", limit);
    return next();
  }

  res.setHeader("X-Plan", plan);
  res.setHeader("X-Remaining", Math.max(0, limit - rec.used));

  if (rec.used > limit) {
    return res.status(402).json({
      error: `Limit reached for ${plan}. Please upgrade on /upgrade.`,
      plan, limit, used: rec.used
    });
  }

  next();
});

// ============================================================================
// /generate — listing generator
// ============================================================================
app.post("/generate", async (req, res) => {
  try {
    const { features = "", tone = "Professional", length = "short", audience = "Buyers" } = req.body || {};
    if (!features.trim()) return res.status(400).json({ error: "Please provide key features." });

    const system = `You are a real-estate copywriter. Return JSON: { "meta": { "title": string, "bullets": string[] }, "description": string }.`;
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
        { role: "user",   content: user   }
      ],
      response_format: { type: "json_object" }
    });

    let data;
    try { data = JSON.parse(resp.choices?.[0]?.message?.content || "{}"); }
    catch { data = {}; }

    const title = (data?.meta?.title || "Charming Move-In Ready Home").toString().slice(0, 80);
    const bullets = Array.isArray(data?.meta?.bullets) ? data.meta.bullets.slice(0,4) : [];
    const description = (data?.description || "Well-presented home close to transit.").toString();

    return res.json({ meta: { title, bullets }, description });
  } catch (e) {
    console.error("GENERATE ERROR:", e?.status, e?.code, e?.message);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

// ============================================================================
// Stripe Checkout — create checkout session for Starter / Growth
// ============================================================================
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { plan } = req.body || {};

    let priceId;
    if (plan === "starter") priceId = STARTER_PRICE_ID;
    else if (plan === "growth") priceId = GROWTH_PRICE_ID;
    else return res.status(400).json({ error: "Invalid plan selected" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: SUCCESS_URL + "?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: CANCEL_URL,
      billing_address_collection: "auto",
      allow_promotion_codes: true,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe Checkout error:", err);
    return res.status(500).json({ error: "Unable to create checkout session" });
  }
});

// ----------------------------------------------------------------------------
// START
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`QuickListing running on http://localhost:${PORT}`));
