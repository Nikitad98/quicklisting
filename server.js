// server.js — QuickListing (stable env + caps + boss + stripe plan-redirect)
// ---------------------------------------------------
const path = require("path");
const express = require("express");
const { OpenAI } = require("openai");
const Stripe = require("stripe");
require("dotenv").config();

// ---------- SAFE ENV HELPER (removes hidden spaces/newlines) ----------
const env = (key, fallback = "") =>
  (process.env[key] ?? fallback).toString().trim();

const app = express();
app.use(express.json());

// ---- Static assets ----------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// ---- Pages ------------------------------------------------------------------
app.get("/",       (_,res)=>res.sendFile(path.join(__dirname,"public","landing.html")));
app.get("/app",    (_,res)=>res.sendFile(path.join(__dirname,"public","app.html")));
app.get("/upgrade",(_,res)=>res.sendFile(path.join(__dirname,"public","upgrade.html")));
app.get("/success",(_,res)=>res.sendFile(path.join(__dirname,"public","success.html")));

// ---- Health -----------------------------------------------------------------
app.get("/version",(_,res)=>res.json({ ok:true, app:"QuickListing", version:"1.0.0" }));

// ============================================================================
// Plans + caps (per month per IP) — TEMP UNTIL REAL ACCOUNTS/WEBHOOKS
// ============================================================================
const CAPS = { free: 10, starter: 150, growth: 500, boss: 999999 };
const usageByIp = new Map();

// boss bypass check
function isBoss(req){
  const adminHeader = (req.headers["x-admin-key"] || "").toString().trim();
  return adminHeader && adminHeader === env("ADMIN_KEY");
}

// plan from header (later from Stripe/webhooks)
function getPlan(req){
  if (isBoss(req)) return "boss";
  const p = (req.headers["x-plan"] || "free").toString().toLowerCase().trim();
  return ["free","starter","growth"].includes(p) ? p : "free";
}

// Count only /generate POST calls, once per month per IP (+plan)
app.use((req, res, next) => {
  if (req.path !== "/generate") return next();

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    "unknown";

  const now = new Date();
  const month = now.getUTCFullYear() + "-" + String(now.getUTCMonth()+1).padStart(2,"0");
  const plan = getPlan(req);

  const rec = usageByIp.get(ip) || { month, plan, used: 0 };
  if (rec.month !== month) { rec.month = month; rec.used = 0; }
  rec.plan = plan;
  rec.used += 1;
  usageByIp.set(ip, rec);

  const limit = CAPS[plan] ?? CAPS.free;

  // expose plan/remaining for frontend meter
  res.setHeader("X-Plan", plan);
  // IMPORTANT: headers must be ASCII (no ∞)
  res.setHeader("X-Remaining", plan === "boss" ? "INF" : String(Math.max(0, limit - rec.used)));

  if (plan !== "boss" && rec.used > limit) {
    return res.status(402).json({
      error: `Limit reached for ${plan}. Please upgrade on /upgrade.`,
      plan, limit, used: rec.used
    });
  }
  next();
});

// ============================================================================
// Stripe setup
// ============================================================================
const stripeSecret = env("STRIPE_SECRET_KEY");
const stripe = stripeSecret ? Stripe(stripeSecret) : null;

const STARTER_PRICE_ID = env("STRIPE_STARTER_PRICE_ID");
const GROWTH_PRICE_ID  = env("STRIPE_GROWTH_PRICE_ID");

// Base success URL (we append plan automatically)
const SUCCESS_URL_BASE = env("STRIPE_SUCCESS_URL", "https://quicklisting.onrender.com/success");
const CANCEL_URL       = env("STRIPE_CANCEL_URL",  "https://quicklisting.onrender.com/upgrade");

// create checkout session
app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe not configured." });

    const { plan } = req.body || {};
    const priceId =
      plan === "starter" ? STARTER_PRICE_ID :
      plan === "growth"  ? GROWTH_PRICE_ID  :
      null;

    if (!priceId) return res.status(400).json({ error: "Invalid plan selected." });

    const success_url = `${SUCCESS_URL_BASE}?plan=${plan}`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url,
      cancel_url: CANCEL_URL
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("STRIPE ERROR:", e);
    res.status(500).json({ error: "Unable to create checkout session." });
  }
});

// ============================================================================
// /generate — OpenAI listing generator
// ============================================================================
const openai = new OpenAI({ apiKey: env("OPENAI_API_KEY") });

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

// ----------------------------------------------------------------------------
// START
// ----------------------------------------------------------------------------
const PORT = env("PORT", 3000);
app.listen(PORT, () => console.log(`QuickListing running on http://localhost:${PORT}`));
