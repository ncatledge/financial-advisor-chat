// server.js
const express = require("express");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");

const app = express();
const cors = require("cors");
app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const sessionData = {};

const BASE_URL = process.env.BASE_URL || "https://financial-advisor-chat-wczs.onrender.com";

// 🔧 Helper to normalize Make/Zapier weird keys
function normalizeBody(body) {
  const normalized = {};
  for (let key in body) {
    const cleanKey = key.replace(/"/g, "");
    normalized[cleanKey] = body[key];
  }
  return normalized;
}

// 📥 Receive client data from Make, generate opening message, return chat link
app.post("/webhook/data", async (req, res) => {
  console.log("RAW BODY:", req.body);

  const body = normalizeBody(req.body);
  console.log("NORMALIZED BODY:", body);

  // Extract clientId and first_name
  let clientId = body.clientId || body.financialNumbers?.clientId || "default-user";
  let first_name = body.first_name || body.financialNumbers?.first_name || "User";

  // Extract financial numbers
  let income = Number(body.income ?? body.financialNumbers?.income ?? body.financialNumbers?.invoice);
  let debt = Number(body.debt ?? body.financialNumbers?.debt ?? body.financialNumbers?.due);
  let savings = Number(body.savings ?? body.financialNumbers?.savings ?? body.financialNumbers?.paid);

  if (isNaN(income) || isNaN(debt) || isNaN(savings)) {
    console.log("❌ Missing or invalid financial fields:", { income, debt, savings, body });
    return res.status(400).json({ success: false, error: "Missing or invalid financial data" });
  }

  // Compute score out of 100
  let financial_score = 0;
  let improvement_areas = [];

  // 1. Debt-to-income ratio (34 points)
  // Below 30% = full points, scales down linearly up to 100%+
  const dtiRatio = income > 0 ? debt / income : 1;
  if (dtiRatio <= 0.30) {
    financial_score += 34;
  } else if (dtiRatio < 1.0) {
    financial_score += Math.round(34 * (1 - (dtiRatio - 0.30) / 0.70));
    improvement_areas.push(`Your debt-to-income ratio is ${Math.round(dtiRatio * 100)}%. Aim to get this below 30%.`);
  } else {
    improvement_areas.push(`Your debt ($${debt}) exceeds your income ($${income}). Prioritize debt reduction.`);
  }

  // 2. Savings rate (33 points)
  // savings / income — above 20% = full points, scales down to 0
  const savingsRate = income > 0 ? savings / income : 0;
  if (savingsRate >= 0.20) {
    financial_score += 33;
  } else if (savingsRate > 0) {
    financial_score += Math.round(33 * (savingsRate / 0.20));
    improvement_areas.push(`Your savings rate is ${Math.round(savingsRate * 100)}%. Try to save at least 20% of your income.`);
  } else {
    improvement_areas.push("You currently have no savings. Start with a small monthly savings goal.");
  }

  // 3. Emergency fund — savings covers months of income (33 points)
  // 6+ months = full, 3-6 = partial, under 3 = 0
  const monthlyIncome = income / 12;
  const monthsCovered = monthlyIncome > 0 ? savings / monthlyIncome : 0;
  if (monthsCovered >= 6) {
    financial_score += 33;
  } else if (monthsCovered >= 3) {
    financial_score += Math.round(33 * ((monthsCovered - 3) / 3));
    improvement_areas.push(`Your emergency fund covers ${monthsCovered.toFixed(1)} months. Aim for at least 6 months of income.`);
  } else {
    improvement_areas.push(`Your emergency fund covers only ${monthsCovered.toFixed(1)} months. Build this up to 6 months of income.`);
  }

  // Store session
  sessionData[clientId] = {
    first_name,
    income,
    debt,
    savings,
    financial_score,
    improvement_areas,
    openingMessage: null,
    history: []
  };

  // Generate opening message
  const openingPrompt = `
You are a financial health advisor AI.

Client:
Name: ${first_name}
Income: $${income}
Debt: $${debt}
Savings: $${savings}
Financial Score: ${financial_score}/100

Improvement Areas:
${improvement_areas.length ? improvement_areas.join("\n") : "None — excellent financial health!"}

Generate a warm, concise opening greeting for this client. 
- Address them by first name
- Give a brief summary of their financial health score (${financial_score}/100)
- Mention 1-2 key observations from their data
- End by inviting them to ask questions or request suggestions for improvement
- Keep it to 3-4 sentences, friendly and professional
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "You are a financial health advisor AI. Be warm, clear, and concise." },
        { role: "user", content: openingPrompt }
      ],
      temperature: 0.3,
    });

    const openingMessage = completion.choices[0].message.content;
    sessionData[clientId].openingMessage = openingMessage;

    // Seed chat history with the opening so follow-up conversations have context
    sessionData[clientId].history = [
      { role: "assistant", content: openingMessage }
    ];

    console.log("✅ Session ready for:", clientId);

    const chatLink = `${BASE_URL}/chat/${clientId}`;
    return res.json({ success: true, chatLink });

  } catch (err) {
    console.error("❌ OpenAI error during greeting:", err);
    return res.status(500).json({ success: false, error: "Failed to generate opening message" });
  }
});

// 📤 Return the pre-generated opening message for a client
app.get("/session/:clientId", (req, res) => {
  const { clientId } = req.params;
  const session = sessionData[clientId];

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json({
    first_name: session.first_name,
    financial_score: session.financial_score,
    openingMessage: session.openingMessage
  });
});

// 💬 Handle ongoing chat messages
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

  // Add user message to history
  clientMemory.history.push({ role: "user", content: message });

  const systemPrompt = `
You are a financial health advisor AI.

Client context:
Name: ${clientMemory.first_name}
Income: $${clientMemory.income}
Debt: $${clientMemory.debt}
Savings: $${clientMemory.savings}
Financial Score: ${clientMemory.financial_score}/100
Improvement Areas: ${clientMemory.improvement_areas.length ? clientMemory.improvement_areas.join("; ") : "None"}

Answer the client's questions clearly and helpfully. Be concise, warm, and practical.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: systemPrompt },
        ...clientMemory.history
      ],
      temperature: 0.2,
    });

    const botReply = completion.choices[0].message.content;

    // Add AI reply to history for context in future messages
    clientMemory.history.push({ role: "assistant", content: botReply });

    res.json({ reply: botReply });

  } catch (err) {
    console.error(err);
    res.status(500).send("AI error");
  }
});


// 🔚 End session — clears client from memory
// TODO: before deleting, persist history to database when conversation saving is added
app.post("/end-session", (req, res) => {
  const { clientId } = req.body;
  if (clientId && sessionData[clientId]) {
    console.log(`🔚 Session ended for: ${clientId}`);
    delete sessionData[clientId];
  }
  res.json({ success: true });
});

// 🌐 Serve the chat page for a specific client
app.get("/chat/:clientId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));