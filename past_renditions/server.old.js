// server.js
const express = require("express");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const cors = require("cors");
app.use(cors());
app.use(bodyParser.json());

// ── OpenAI ───────────────────────────────────────────────
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ── Supabase ─────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── In-memory session cache ───────────────────────────────
// Holds active sessions so we don't hit Supabase on every message
const sessionData = {};

const BASE_URL = process.env.BASE_URL || "https://financial-advisor-chat-wczs.onrender.com";

// ── Helpers ───────────────────────────────────────────────
function normalizeBody(body) {
  const normalized = {};
  for (let key in body) {
    const cleanKey = key.replace(/"/g, "");
    normalized[cleanKey] = body[key];
  }
  return normalized;
}

function computeScore(income, debt, savings) {
  let score = 0;
  const improvement_areas = [];

  // 1. Debt-to-income ratio (34 points)
  const dtiRatio = income > 0 ? debt / income : 1;
  if (dtiRatio <= 0.30) {
    score += 34;
  } else if (dtiRatio < 1.0) {
    score += Math.round(34 * (1 - (dtiRatio - 0.30) / 0.70));
    improvement_areas.push(`Your debt-to-income ratio is ${Math.round(dtiRatio * 100)}%. Aim to get this below 30%.`);
  } else {
    improvement_areas.push(`Your debt ($${debt}) exceeds your income ($${income}). Prioritize debt reduction.`);
  }

  // 2. Savings rate (33 points)
  const savingsRate = income > 0 ? savings / income : 0;
  if (savingsRate >= 0.20) {
    score += 33;
  } else if (savingsRate > 0) {
    score += Math.round(33 * (savingsRate / 0.20));
    improvement_areas.push(`Your savings rate is ${Math.round(savingsRate * 100)}%. Try to save at least 20% of your income.`);
  } else {
    improvement_areas.push("You currently have no savings. Start with a small monthly savings goal.");
  }

  // 3. Emergency fund (33 points)
  const monthlyIncome = income / 12;
  const monthsCovered = monthlyIncome > 0 ? savings / monthlyIncome : 0;
  if (monthsCovered >= 6) {
    score += 33;
  } else if (monthsCovered >= 3) {
    score += Math.round(33 * ((monthsCovered - 3) / 3));
    improvement_areas.push(`Your emergency fund covers ${monthsCovered.toFixed(1)} months. Aim for at least 6 months of income.`);
  } else {
    improvement_areas.push(`Your emergency fund covers only ${monthsCovered.toFixed(1)} months. Build this up to 6 months of income.`);
  }

  return { score, improvement_areas };
}

function buildOpeningMessage(first_name, financial_score, improvement_areas) {
  const areas = improvement_areas.length
    ? improvement_areas.map((a, i) => `${i + 1}. ${a}`).join("\n")
    : "No major issues — your finances are in great shape!";

  return `Hello ${first_name}, your financial health score is ${financial_score}/100.\n\nKey areas to focus on:\n${areas}\n\nFeel free to ask me any questions or request suggestions for improvement.`;
}

async function saveSessionToSupabase(clientId) {
  const s = sessionData[clientId];
  if (!s) return;

  const { error } = await supabase
    .from("sessions")
    .upsert({
      client_id: clientId,
      first_name: s.first_name,
      income: s.income,
      debt: s.debt,
      savings: s.savings,
      financial_score: s.financial_score,
      improvement_areas: s.improvement_areas,
      history: s.history,
      updated_at: new Date().toISOString()
    }, { onConflict: "client_id" });

  if (error) console.error("❌ Supabase save error:", error);
}

// ── Routes ────────────────────────────────────────────────

// 📥 New client — receive data from Make, store session, return chat link
app.post("/webhook/data", async (req, res) => {
  console.log("RAW BODY:", req.body);

  const body = normalizeBody(req.body);
  console.log("NORMALIZED BODY:", body);

  let clientId = body.clientId || "default-user";
  let first_name = body.first_name || "User";

  let income = Number(body.income ?? 0);
  let debt = Number(body.debt ?? 0);
  let savings = Number(body.savings ?? 0);

  if (isNaN(income) || isNaN(debt) || isNaN(savings)) {
    console.log("❌ Invalid financial fields:", { income, debt, savings });
    return res.status(400).json({ success: false, error: "Missing or invalid financial data" });
  }

  const { score: financial_score, improvement_areas } = computeScore(income, debt, savings);
  const openingMessage = buildOpeningMessage(first_name, financial_score, improvement_areas);

  // Store in memory
  sessionData[clientId] = {
    first_name,
    income,
    debt,
    savings,
    financial_score,
    improvement_areas,
    openingMessage,
    isReturning: false,
    // Seed history with opening message so AI has context from the start
    history: [{ role: "assistant", content: openingMessage }]
  };

  // Persist to Supabase
  await saveSessionToSupabase(clientId);

  console.log(`✅ New session ready for: ${clientId} | Score: ${financial_score}/100`);

  const chatLink = `${BASE_URL}/chat/${clientId}`;
  return res.json({ success: true, chatLink });
});

// 📤 Load session for chat page — handles both new and returning clients
app.get("/session/:clientId", async (req, res) => {
  const { clientId } = req.params;

  // Check memory cache first
  if (sessionData[clientId]) {
    const s = sessionData[clientId];
    return res.json({
      first_name: s.first_name,
      financial_score: s.financial_score,
      openingMessage: s.openingMessage,
      history: s.history,
      isReturning: s.isReturning || false
    });
  }

  // Not in memory — check Supabase (returning client)
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("client_id", clientId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: "Session not found" });
  }

  // Load into memory cache
  sessionData[clientId] = {
    first_name: data.first_name,
    income: data.income,
    debt: data.debt,
    savings: data.savings,
    financial_score: data.financial_score,
    improvement_areas: data.improvement_areas,
    openingMessage: buildOpeningMessage(data.first_name, data.financial_score, data.improvement_areas),
    history: data.history || [],
    isReturning: true
  };

  console.log(`🔄 Returning client loaded from Supabase: ${clientId}`);

  return res.json({
    first_name: data.first_name,
    financial_score: data.financial_score,
    openingMessage: sessionData[clientId].openingMessage,
    history: data.history || [],
    isReturning: true
  });
});

// 💬 Chat messages
app.post("/chat", async (req, res) => {
  let { clientId, message } = req.body;
  if (!clientId) clientId = "default-user";

  if (!message) {
    return res.status(400).send("Missing chat message");
  }

  const clientMemory = sessionData[clientId];
  if (!clientMemory || clientMemory.income === undefined) {
    return res.status(400).send("Client financial data not found");
  }

  clientMemory.history.push({ role: "user", content: message });

  const systemPrompt = `You are a financial health advisor AI.

Client context:
Name: ${clientMemory.first_name}
Income: $${clientMemory.income}
Debt: $${clientMemory.debt}
Savings: $${clientMemory.savings}
Financial Score: ${clientMemory.financial_score}/100
Improvement Areas: ${clientMemory.improvement_areas.length ? clientMemory.improvement_areas.join("; ") : "None"}

Answer the client's questions clearly and helpfully. Be concise, warm, and practical.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...clientMemory.history
      ],
      temperature: 0.2,
    });

    const botReply = completion.choices[0].message.content;
    clientMemory.history.push({ role: "assistant", content: botReply });

    // Save updated history to Supabase after every message
    await saveSessionToSupabase(clientId);

    res.json({ reply: botReply });

  } catch (err) {
    console.error(err);
    res.status(500).send("AI error");
  }
});

// 🔚 End session — saves to Supabase and clears memory
app.post("/end-session", async (req, res) => {
  const { clientId } = req.body;

  if (clientId && sessionData[clientId]) {
    await saveSessionToSupabase(clientId);
    delete sessionData[clientId];
    console.log(`🔚 Session ended and saved for: ${clientId}`);
  }

  res.json({ success: true });
});

// 🌐 Serve chat page
app.get("/chat/:clientId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));