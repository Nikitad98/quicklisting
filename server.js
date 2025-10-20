// server.js — QuickListing (clean)
const path = require("path");
const express = require("express");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();
app.use(express.json());

// serve /public assets (HTML, CSS, images, JS)
app.use(express.static(path.join(__dirname, "public")));

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- ROUTES ----------

// serve static
app.use(express.static(path.join(__dirname, "public")));

// Landing page (marketing)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

// App UI (the generator)
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

// Health/Probe
app.get("/version", (_req, res) => {
  res.json({ status: "QuickListing API is live", version: "1.0.0" });
});

app.get("/probe", async (_req, res) => {
  try {
    const r = await openai.models.list();
    res.send("probe-ok: " + (r.data?.length || 0) + " models");
  } catch (e) {
    console.error("PROBE ERROR:", e.status, e.code || e.message);
    res.status(500).send("probe-fail: " + (e.code || e.message));
  }
});
// ==== SIMPLE MONTHLY CAPS (per IP, MVP) ====
// Change these when you adjust pricing:
const CAPS = { free: 15, starter: 150, pro: 600, office: 2000 };

const usageByIp = new Map(); // ip -> { month, counts: { plan, used } }

// Helper to get plan from header (MVP: we pass plan from frontend/localStorage)
function getPlan(req) {
  // Expect "x-plan: free|starter|pro|office"
  const p = (req.headers["x-plan"] || "free").toLowerCase();
  return ["free","starter","pro","office"].includes(p) ? p : "free";
}

app.use((req, res, next) => {
  if (req.path !== "/generate") return next();

  // ---- Monthly cap middleware (place ABOVE /generate) ----
const CAPS = { free: 15, starter: 150, pro: 600, office: 2000 };
const usageByIp = new Map(); // ip -> { month, used, plan }

// For now everyone is "free". Later we’ll set this from Stripe/login.
function getPlan(/* req */) { return "free"; }

app.use((req, res, next) => {
  // Only count calls to the generator
  if (req.path !== "/generate") return next();

  const ip = (req.headers["x-forwarded-for"] ||
              req.socket?.remoteAddress ||
              req.ip ||
              "unknown").toString();

  const plan = getPlan(req);
  const month = new Date().getMonth();
  let rec = usageByIp.get(ip);

  // New month or first time => reset
  if (!rec || rec.month !== month) rec = { month, used: 0, plan };

  // If already at cap, block BEFORE increment
  if (rec.used >= CAPS[plan]) {
    res.setHeader("X-Plan", plan);
    res.setHeader("X-Remaining", 0);
    return res.status(402).json({ error: `Monthly limit reached for ${plan}. Upgrade at /upgrade.` });
  }

  // Count this request
  rec.plan = plan;
  rec.used += 1;
  usageByIp.set(ip, rec);

  // Expose remaining in headers for the UI
  res.setHeader("X-Plan", plan);
  res.setHeader("X-Remaining", Math.max(0, CAPS[plan] - rec.used));

  next();
});


// Main generate route (keep your existing prompt logic here)
app.post("/generate", async (req, res) => {
  try {
    const { features = "", tone = "Professional", length = "short", audience = "General" } = req.body;
    if (!features.trim()) return res.status(400).json({ error: "Please enter features." });

    const system = `You are a real-estate copywriter. Keep it concise, on-brand, and MLS-safe. Tone: ${tone}. Audience: ${audience}. Length: ${length}.`;
    const user = `Create a listing description from these features: ${features}`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const description = resp.choices?.[0]?.message?.content?.trim() || "";

    // quick second pass: title + bullets JSON
    const refine = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "From the listing text, return JSON: {\"title\": \"...\", \"bullets\": [\"...\",\"...\"]} only." },
        { role: "user", content: description }
      ]
    });

    let meta = { title: "Suggested Listing Title", bullets: [] };
    try {
      const txt = refine.choices?.[0]?.message?.content || "{}";
      meta = JSON.parse(txt);
    } catch { /* fallback keeps default meta */ }

    res.json({ description, meta });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to generate" });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`QuickListing → http://localhost:${PORT}`));
