// api/index.js
const express = require("express");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
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
// Uses secret API key — never commit this value, only via environment variables
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

const BASE_URL = process.env.BASE_URL || "https://financial-advisor-chat-five.vercel.app";

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

// ── Supabase helpers ──────────────────────────────────────
async function getSession(clientId) {
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("client_id", clientId)
    .single();

  if (error || !data) return null;
  return data;
}

async function saveSession(sessionObj) {
  const { error } = await supabase
    .from("sessions")
    .upsert(sessionObj, { onConflict: "client_id" });

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
    return res.status(400).json({ success: false, error: "Missing or invalid financial data" });
  }

  const { score: financial_score, improvement_areas } = computeScore(income, debt, savings);
  const openingMessage = buildOpeningMessage(first_name, financial_score, improvement_areas);

  await saveSession({
    client_id: clientId,
    first_name,
    income,
    debt,
    savings,
    financial_score,
    improvement_areas,
    history: [{ role: "assistant", content: openingMessage }],
    updated_at: new Date().toISOString()
  });

  // Create the default first conversation for this client
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("client_id", clientId)
    .limit(1);

  if (!existing || existing.length === 0) {
    const { data: conv } = await supabase
      .from("conversations")
      .insert({ client_id: clientId, title: "Financial Overview" })
      .select()
      .single();

    if (conv) {
      await supabase.from("messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: openingMessage
      });
    }
  }

  console.log(`✅ Session saved for: ${clientId} | Score: ${financial_score}/100`);

  const chatLink = `${BASE_URL}/chat/${clientId}`;
  return res.json({ success: true, chatLink });
});

// 📤 Load session for chat page
app.get("/session/:clientId", async (req, res) => {
  const { clientId } = req.params;
  const session = await getSession(clientId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const openingMessage = buildOpeningMessage(
    session.first_name,
    session.financial_score,
    session.improvement_areas
  );

  return res.json({
    first_name: session.first_name,
    financial_score: session.financial_score,
    openingMessage,
  });
});

// 📋 List all conversations for a client
app.get("/conversations/:clientId", async (req, res) => {
  const { clientId } = req.params;

  const session = await getSession(clientId);
  if (!session) return res.status(404).json({ error: "Client not found" });

  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("client_id", clientId)
    .order("updated_at", { ascending: false });

  if (error) return res.status(500).json({ error: "Failed to load conversations" });

  res.json({ conversations: data });
});

// ➕ Create a new conversation
app.post("/conversations/:clientId", async (req, res) => {
  const { clientId } = req.params;

  const session = await getSession(clientId);
  if (!session) return res.status(404).json({ error: "Client not found" });

  const { data, error } = await supabase
    .from("conversations")
    .insert({ client_id: clientId, title: "New Conversation" })
    .select()
    .single();

  if (error) return res.status(500).json({ error: "Failed to create conversation" });

  res.json({ conversation: data });
});

// 🗑️ Delete a conversation (clientId must match)
app.delete("/conversations/:conversationId", async (req, res) => {
  const { conversationId } = req.params;
  const { clientId } = req.body;

  if (!clientId) return res.status(400).json({ error: "clientId required" });

  // Verify this conversation belongs to the requesting client
  const { data: conv, error: fetchError } = await supabase
    .from("conversations")
    .select("client_id")
    .eq("id", conversationId)
    .single();

  if (fetchError || !conv) return res.status(404).json({ error: "Conversation not found" });
  if (conv.client_id !== clientId) return res.status(403).json({ error: "Unauthorized" });

  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", conversationId);

  if (error) return res.status(500).json({ error: "Failed to delete conversation" });

  res.json({ success: true });
});

// 📨 Load messages for a conversation
app.get("/conversations/:conversationId/messages", async (req, res) => {
  const { conversationId } = req.params;
  const { clientId } = req.query;

  if (!clientId) return res.status(400).json({ error: "clientId required" });

  // Verify ownership
  const { data: conv, error: fetchError } = await supabase
    .from("conversations")
    .select("client_id")
    .eq("id", conversationId)
    .single();

  if (fetchError || !conv) return res.status(404).json({ error: "Conversation not found" });
  if (conv.client_id !== clientId) return res.status(403).json({ error: "Unauthorized" });

  const { data, error } = await supabase
    .from("messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: "Failed to load messages" });

  res.json({ messages: data });
});

// 💬 Chat — scoped to a conversation
app.post("/chat", async (req, res) => {
  let { clientId, conversationId, message } = req.body;
  if (!clientId) clientId = "default-user";
  if (!message) return res.status(400).send("Missing chat message");

  const session = await getSession(clientId);
  if (!session) return res.status(400).send("Client financial data not found");

  // If no conversationId, create a new thread
  if (!conversationId) {
    const { data: newConv } = await supabase
      .from("conversations")
      .insert({ client_id: clientId, title: "New Conversation" })
      .select()
      .single();
    conversationId = newConv.id;
  } else {
    // Verify ownership
    const { data: conv } = await supabase
      .from("conversations")
      .select("client_id")
      .eq("id", conversationId)
      .single();
    if (!conv || conv.client_id !== clientId) {
      return res.status(403).send("Unauthorized");
    }
  }

  // Load existing messages for context
  const { data: existingMessages } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  const history = existingMessages || [];
  history.push({ role: "user", content: message });

  const systemPrompt = `You are a financial health advisor AI.

Client context:
Name: ${session.first_name}
Income: $${session.income}
Debt: $${session.debt}
Savings: $${session.savings}
Financial Score: ${session.financial_score}/100
Improvement Areas: ${session.improvement_areas.length ? session.improvement_areas.join("; ") : "None"}

STRICT RULES — you must follow these exactly:
- Respond in 2 sentences maximum, no exceptions
- No bullet points, no numbered lists, no bold text
- Be direct and specific to this client's actual numbers`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...history
      ],
      temperature: 0.2,
      max_tokens: 100
    });

    const botReply = completion.choices[0].message.content;

    // Save user message + AI reply
    await supabase.from("messages").insert([
      { conversation_id: conversationId, role: "user", content: message },
      { conversation_id: conversationId, role: "assistant", content: botReply }
    ]);

    // Auto-title: use first user message (truncated)
    if (history.length === 1) {
      const title = message.length > 50 ? message.slice(0, 47) + "..." : message;
      await supabase
        .from("conversations")
        .update({ title, updated_at: new Date().toISOString() })
        .eq("id", conversationId);
    } else {
      await supabase
        .from("conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", conversationId);
    }

    res.json({ reply: botReply, conversationId });

  } catch (err) {
    console.error(err);
    res.status(500).send("AI error");
  }
});

// 🔚 End session
app.post("/end-session", async (req, res) => {
  const { clientId } = req.body;

  if (clientId) {
    const session = await getSession(clientId);
    if (session) {
      await saveSession({
        ...session,
        client_id: clientId,
        updated_at: new Date().toISOString()
      });
      console.log(`🔚 Session ended for: ${clientId}`);
    }
  }

  res.json({ success: true });
});

module.exports = app;
