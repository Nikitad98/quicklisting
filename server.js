// server.js — Real Estate AI
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });

// 🔑 Debug log to confirm key is loading
console.log(
  "Key prefix:",
  (process.env.OPENAI_API_KEY || "").slice(0, 7),
  "len:",
  (process.env.OPENAI_API_KEY || "").length
);

const { OpenAI } = require("openai");
const openai = new OpenAI({ apiKey: (process.env.OPENAI_API_KEY || "").trim() });

const express = require("express");
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 🧪 Probe endpoint — visit http://localhost:3000/probe
app.get("/probe", async (_, res) => {
  try {
    const r = await openai.models.list();
    res.send("probe-ok: " + (r.data?.length || 0) + " models");
  } catch (e) {
    console.error("PROBE ERROR:", e.status, e.code || e.message);
    res.status(500).send("probe-fail: " + (e.code || e.message));
  }
});

// 🏠 Main generate route
app.post("/generate", async (req, res) => {
  try {
    const { features = "", tone = "Professional", length = "short", audience = "buyers" } = req.body || {};
    if (!features.trim()) return res.status(400).json({ error: "Please enter some features." });

    const lengthRule =
      length === "short" ? "2-3 sentences" :
      length === "medium" ? "4-6 sentences" :
      "1 short paragraph (6-8 sentences)";

    const system = `You are a real-estate copywriter. Write accurate, concise listing blurbs. No emojis, prices, or contact info. Use fair-housing-safe language.`;
    const user = `Create a ${lengthRule} property description for ${audience}.
Tone: ${tone}.
Key features: ${features}.
Rules: concise, highlight location perks + standout amenities, no ALL CAPS or hashtags.`;

    // Generate description
    const descResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.65,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    });
    const description = descResp.choices?.[0]?.message?.content?.trim() || "";

    // Generate title + bullets
    const metaResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: "From the listing text, return JSON ONLY: {\"title\":\"<=8 words\",\"bullets\":[\"4-6 short bullets\"]}" },
        { role: "user", content: description }
      ]
    });

    let meta = { title: "", bullets: [] };
    try {
      const txt = metaResp.choices?.[0]?.message?.content || "{}";
      const start = txt.indexOf("{"); const end = txt.lastIndexOf("}");
      meta = JSON.parse(txt.slice(start, end + 1));
    } catch {}

    res.json({ description, meta });
  } catch (e) {
    console.error("OPENAI ERROR:", e.status, e.message);
    res.status(500).json({ error: "Failed to generate description." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Real-Estate AI → http://localhost:${PORT}`));

