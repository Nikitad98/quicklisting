// server.js — QuickListing (clean, complete)
const path = require("path");
const fs = require("fs");
const express = require("express");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Landing & App ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.get("/upgrade", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "upgrade.html"));
});

// ---------- Health ----------
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

// ---------- SIMPLE MONTHLY CAPS (per IP, MVP) ----------
const CAPS = { free: 15, starter: 150, pro: 600, office: 2000 };
const usageByIp = new Map(); // ip -> { month, used, plan }
function getPlan(req) {
  const p = (req.headers["x-plan"] || "free").toLowerCase();
  return ["free", "starter", "pro", "office"].includes(p) ? p : "free";
}

// Apply only to /generate calls
app.use((req, res, next) => {
  if (req.path !== "/generate") return next();

  const ip = (req.headers["x-forwarded-for"] ||
              req.socket?.remoteAddress ||
              req.ip ||
              "unknown").toString();
  const plan = getPlan(req);
  const month = new Date().getMonth();

  let rec = usageByIp.get(ip);
  if (!rec || rec.month !== month) rec = { month, used: 0, plan };

  // Block before counting if already at cap
  if (rec.used >= CAPS[plan]) {
    res.setHeader("X-Plan", plan);
    res.setHeader("X-Remaining", 0);
    return res.status(402).json({ error: `Monthly limit reached for ${plan}. Upgrade at /upgrade.` });
  }

  // Count this request
  rec.plan = plan;
  rec.used += 1;
  usageByIp.set(ip, rec);

  // Expose remaining for UI
  res.setHeader("X-Plan", plan);
  res.setHeader("X-Remaining", Math.max(0, CAPS[plan] - rec.used));
  next();
});

// ---------- GENERATE ----------
app.post("/generate", async (req, res) => {
  try {
    const { features = "", tone = "Professional", length = "short", audience = "General" } = req.body;
    if (!features.trim()) return res.status(400).json({ error: "Please enter features." });

    const system = `You are a real-estate copywriter. Keep it concise, MLS-safe, and on-brand.
Tone: ${tone}. Audience: ${audience}. Length: ${length}.`;
    const user = `Create a listing description from these features: ${features}`;

    // 1) Main description
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const description = resp.choices?.[0]?.message?.content?.trim() || "";

    // Rough token estimate (chars / 4)
    const inputChars = JSON.stringify(req.body || {}).length;
    const outputChars = (description || "").length;
    const estTokens = Math.round((inputChars + outputChars) / 4);
    console.log("Estimated tokens used:", estTokens);

    // Log usage locally (creates usage.csv on first write)
    fs.appendFileSync(
      path.join(__dirname, "usage.csv"),
      `${Date.now()},${getPlan(req)},${estTokens}\n`
    );

    // 2) Title + bullets JSON
    const refine = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: 'From the listing text, return JSON only like {"title":"...","bullets":["...","..."]}.' },
        { role: "user", content: description }
      ]
    });

    let meta = { title: "Suggested Listing Title", bullets: [] };
    try {
      const txt = refine.choices?.[0]?.message?.content || "{}";
      meta = JSON.parse(txt);
      if (!Array.isArray(meta.bullets)) meta.bullets = [];
    } catch { /* keep default meta */ }

    res.json({ description, meta });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to generate" });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`QuickListing → http://localhost:${PORT}`));
