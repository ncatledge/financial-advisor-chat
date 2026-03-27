// server.js
const express = require("express");
const bodyParser = require("body-parser");
const OpenAI = require("openai");

const app = express();
const cors = require("cors");
app.use(cors());

app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const sessionData = {};

// 🔧 Helper to normalize Zapier weird keys
function normalizeBody(body) {
  const normalized = {};

  for (let key in body) {
    const cleanKey = key.replace(/"/g, ""); // removes accidental quotes
    normalized[cleanKey] = body[key];
  }

  return normalized;
}

app.post("/webhook/data", (req, res) => {
  console.log("RAW BODY:", req.body);

  const body = normalizeBody(req.body);

  console.log("NORMALIZED BODY:", body);

  // Support both flat and nested Zapier payloads
  let { clientId, first_name, income, debt, savings } = body;

  // Auto-generate clientId if missing
  if (!clientId) {
    clientId = "default-user";
  }

  // If Zapier sends nested financialNumbers
  if (body.financialNumbers) {
    income = body.financialNumbers.income ?? body.financialNumbers.invoice ?? income;
    debt = body.financialNumbers.debt ?? body.financialNumbers.due ?? debt;
    savings = body.financialNumbers.savings ?? body.financialNumbers.paid ?? savings;
  }


  // Allow missing first_name (optional)
  if (income === undefined || debt === undefined || savings === undefined) {
    console.log("❌ Missing financial fields:", { income, debt, savings, body });
    return res.status(400).send("Missing financial data");
  }

  sessionData[clientId] = sessionData[clientId] || {};
  sessionData[clientId].first_name = first_name || "User";
  sessionData[clientId].income = Number(income);
  sessionData[clientId].debt = Number(debt);
  sessionData[clientId].savings = Number(savings);

  console.log("✅ Stored session:", sessionData[clientId]);

  res.json({ success: true });
});

app.post("/chat", async (req, res) => {
  let { clientId, message } = req.body;

  // Use default client if none provided
  if (!clientId) {
    clientId = "default-user";
  }

  if (!message) {
    return res.status(400).send("Missing chat message");
  }

  const clientMemory = sessionData[clientId] || {};

  if (
    clientMemory.income === undefined ||
    clientMemory.debt === undefined ||
    clientMemory.savings === undefined
  ) {
    return res.status(400).send("Client financial data not found");
  }

  let financial_score = 0;
  let improvement_areas = [];

  if (clientMemory.debt < clientMemory.income) {
    financial_score += 1;
  } else {
    improvement_areas.push("Reduce your debt to be less than your annual income.");
  }

  if (clientMemory.savings * 12 > clientMemory.debt) {
    financial_score += 1;
  } else {
    improvement_areas.push("Increase your savings to cover at least 12 months of debt.");
  }

  sessionData[clientId].financial_score = financial_score;
  sessionData[clientId].improvement_areas = improvement_areas;

  const prompt = `
You are a financial health advisor AI.

Client:
Name: ${clientMemory.first_name}
Income: $${clientMemory.income}
Debt: $${clientMemory.debt}
Savings: $${clientMemory.savings}
Score: ${financial_score}/2

Improvements:
${improvement_areas.length ? improvement_areas.join("\n") : "None"}

User: ${message}
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "You are a financial assistant AI." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    });

    const botReply = completion.choices[0].message.content;

    sessionData[clientId].lastMessage = botReply;

    res.json({ reply: botReply });
  } catch (err) {
    console.error(err);
    res.status(500).send("AI error");
  }
});

app.listen(3000, () => console.log("API listening on port 3000"));

//run local with node server.js