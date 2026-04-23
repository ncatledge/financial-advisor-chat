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

// ── Cognito helpers ───────────────────────────────────────

// Strips null/undefined/empty values before sending to external services
function stripNulls(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== "")
  );
}

// Dot-path lookup for nested Cognito fields (e.g. "FinancialScores.TOTALFINANCIALSCORE")
function cog(data, path) {
  const val = path.split(".").reduce((obj, key) => obj?.[key], data);
  return (val !== null && val !== undefined && val !== "") ? val : null;
}

function buildCognitoOpeningMessage(first_name, data) {
  const f = (path) => cog(data, path) ?? "N/A";

  const score    = f("FinancialScores.TOTALFINANCIALSCORE");
  const incScore = f("FinancialScores.IncomeDebtSubscore");
  const invScore = f("FinancialScores.InvestmentsSubscore");
  const insScore = f("InsuranceSubscore");
  const reScore  = f("FinancialScores.RealEstateSubscore");
  const retScore = f("FinancialScores.RetirementPlanningSubscore");

  return `Hello ${first_name}, your comprehensive financial assessment is complete.\n\nOverall Score: ${score}/100\n• Income & Debt: ${incScore}\n• Investments: ${invScore}\n• Insurance: ${insScore}\n• Real Estate: ${reScore}\n• Retirement Planning: ${retScore}\n\nAsk me anything about your financial picture and I'll reference your full assessment data.`;
}

function buildCognitoSystemPrompt(session) {
  const d = session.cognito_data || {};
  const f = (path) => cog(d, path) ?? "N/A";
  const pct = (path) => { const v = cog(d, path); return v != null ? `${Math.round(v * 100)}%` : "N/A"; };

  return `You are a financial health advisor AI with access to this client's complete financial assessment.

Client: ${session.first_name}
State: ${f("StateOfResidence.State")}
Filing Status: ${f("FilingStatus")}
Age: ${f("ClientAge")}
Dependents: ${f("HowManyDependentsDoYouHave")}
Employment: ${f("Client1EmploymentStatus")}
Overall Financial Score: ${f("FinancialScores.TOTALFINANCIALSCORE")}/100

── Subscores ──
Income/Debt: ${f("FinancialScores.IncomeDebtSubscore")}
Investments: ${f("FinancialScores.InvestmentsSubscore")}
Insurance: ${f("InsuranceSubscore")}
Real Estate: ${f("FinancialScores.RealEstateSubscore")}
Retirement Planning: ${f("FinancialScores.RetirementPlanningSubscore")}

── Income & Cash Flow ──
Total Monthly Income: $${f("TotalMonthlyIncome")}
Total Household Monthly Expenses: $${f("MonthlyExpenses")}
Monthly Cash Flow: $${f("MonthlyCashFlow")}
Current Monthly Savings: $${f("CurrentMonthlySavings")}
Savings Rate: ${pct("SavingsRate")}
Unassigned Cash Flow: $${f("UnassignedCashFlow")}
Additional savings capacity: $${f("HowMuchAdditionalMoneyCouldYouSaveEachMonth")}
Tax-Deferred Contributions: $${f("MonthlyContributionsToTaxDeferredSavings")}
Tax-Free Contributions: $${f("MonthlyTaxFreeContributions")}
Taxable Contributions: $${f("MonthlyContributionsToTaxableAccounts")}

── Debt ──
Estimated Total Debt: $${f("EstimatedTotalDebt")}
DTI Ratio: ${pct("DTIRatio")}
Average Credit Score: ${f("AverageCreditScore")}
Mortgage Balance: $${f("MortgageBalance")}
Credit Card Debt: $${f("CreditCardDebt")}
Student Loans: $${f("StudentLoans")}
Auto Loans: $${f("AutoLoans")}
Personal Loans: $${f("PersonalLoans")}
Home Equity Loan / HELOC: $${f("HomeEquityLoanHELOC")}
Bad Debt: $${f("BadDebt")}
Good Debt: $${f("GoodDebt")}
True Net Worth: $${f("TrueNetWorth")}

── Assets ──
Estimated Assets Total: $${f("EstimatedAssetsTotal")}
Total Gross Assets: $${f("TotalGrossAssets")}
Cash & Bank Accounts: $${f("CashBankAccounts2")}
Total Checking: $${f("TotalCheckingAccountBalance")}
Total Savings: $${f("TotalSavingsAccountBalance")}
Total HYSA: $${f("TotalHighYieldSavingsAccountBalance")}
Real Estate Equity: $${f("RealEstateEquity")}
True Real Estate Equity: $${f("TrueRealEstateEquity")}
Total Brokerage: $${f("TotalBrokerageAccountBalance")}
Total Managed Investments: $${f("TotalManagedInvestmentBalance")}
Crypto: $${f("TotalCryptoExchangeWalletBalance")}
Current Retirement Savings: $${f("CurrentRetirementSavings")}
Roth IRA: $${f("RothIRABalance")}
Traditional IRA: $${f("TraditionalIRABalance")}
401(k) Traditional: $${f("_401kTraditionalBalance")}
401(k) Roth: $${f("_401kRothBalance")}
HSA: $${f("HSABalance")}
Pension: $${f("PensionDefinedPlanBalance")}
529 Plan: $${f("_529PlanBalance")}
Other Assets: $${f("OtherAssets")}
Total Classified Investable Assets: $${f("TotalClassifiedInvestableAssets")}
At-Risk Investments: $${f("TotalInAtRiskInvestments")}
Non-Risk Investments: $${f("TotalInNonRiskInvestments")}

── Tax ──
Tax Bracket: ${pct("TaxBracketPercentage")}
Tax-Free Assets: $${f("TaxFreeAssets")}
Tax-Deferred Assets: $${f("TaxDeferredAssets")}
Taxable Assets: $${f("TaxableAssets")}
Tax Diversification Note: ${f("TaxDiversificationNote")}

── Insurance ──
Insurance Score: ${f("InsuranceScore")}
Life Insurance Adequacy Score: ${f("LifeInsuranceAdequacyScore")}
Disability Insurance Score: ${f("DisabilityInsuranceScore")}
LTC Insurance Score: ${f("LTCInsuranceScore")}
Has Life Insurance: ${f("Client1LifeInsurance")}
Life Insurance Type: ${f("Client1LifeInsuranceType")}
Total Death Benefit: $${f("Client1TotalLifeInsuranceDeathBenefit")}
Cash Value: $${f("Client1CashValue")}
Has Disability Insurance: ${f("Client1DisabilityInsurance")}
Has LTC Insurance: ${f("Client1LTCInsurance")}

── Retirement Planning ──
Desired Retirement Age: ${f("Client1DesiredRetirementAge")}
Retirement Goal: ${f("Client1RetirementGoal")}
Years To Retirement: ${f("Client1YearsToRetirement")}
Desired Monthly Retirement Income: $${f("WhatIsYourDesiredMonthlyIncomeAfterRetirement")}
Projected Retirement Assets: $${f("TotalProjectedRetirementAssets")}
Retirement Income Shortfall: $${f("RetirementIncomeShortfall")}
Total Estimated Social Security: $${f("TotalEstimatedSocialSecurity")}
Retirement Readiness Score: ${f("RetirementReadinessScore")}
Retirement Summary: ${f("RetirementShortfallSummary")}

── Recommendations ──
Income/Debt: ${f("PlannerNotesIncomeDebts.IncomeDebtsRecommendations")}
Investments: ${f("PlannerNotesInvestments.InvestmentRecommendation")}
Insurance: ${f("PlannerNotesInsurance.InsuranceRecommendations")}
Retirement: ${f("PlannerNotesRetirement.RetirementRecommendations")}
Advisor Notes: ${f("AdvisorNotes.AdvisorNotes")}

STRICT RULES — follow exactly:
- Respond in 2 sentences maximum, no exceptions
- No bullet points, no numbered lists, no bold text
- Be direct and specific to this client's actual numbers
- Reference the assessment data above when relevant`;
}

// ── Product lookup tool ───────────────────────────────────
// TODO: Enable once product catalog eligibility logic is finalized.
// Called when the model decides a product recommendation is warranted.
// Filters the catalog by carrier/band and the client's financial profile.
//
// async function getMatchingProducts(args, session) {
//   let query = supabase
//     .from("products")
//     .select("sku, carrier, name, contract_rate, band")
//     .eq("active", true);
//
//   if (args.carrier && args.carrier !== "any") {
//     query = query.eq("carrier", args.carrier);
//   }
//
//   const { data } = await query.limit(4);
//   return data || [];
// }
//
// ── Tool definition — passed to OpenAI on every /chat call ──
// The model decides whether to call it; we never force-invoke it.
//
// const tools = [
//   {
//     type: "function",
//     function: {
//       name: "get_product_recommendations",
//       description: `Retrieve insurance/financial products from the catalog.
// Only call when the client asks about products or a specific product would directly help them.
// Do NOT call for general financial advice.`,
//       parameters: {
//         type: "object",
//         properties: {
//           carrier: {
//             type: "string",
//             description: "Carrier name to filter by, or 'any' for all carriers."
//           }
//         },
//         required: ["carrier"]
//       }
//     }
//   }
// ];

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

  if (error) {
    console.error("❌ Supabase save error:", error);
    throw error;
  }
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

  // Find or create the protected Financial Score conversation.
  // This conversation is permanent — every webhook call appends the latest
  // opening message so the client always has an up-to-date financial record.
  let financialScoreConvId;

  const { data: existingConv } = await supabase
    .from("conversations")
    .select("id")
    .eq("client_id", clientId)
    .eq("is_protected", true)
    .limit(1)
    .single();

  if (existingConv) {
    // Conversation already exists — reuse it
    financialScoreConvId = existingConv.id;
  } else {
    // First time this client has been set up — create the conversation
    const { data: newConv } = await supabase
      .from("conversations")
      .insert({ client_id: clientId, title: "Financial Score", is_protected: true })
      .select()
      .single();
    financialScoreConvId = newConv.id;
  }

  // Always save the opening message so the conversation stays current.
  // If financial data changes, a new entry is appended as a record.
  await supabase.from("messages").insert({
    conversation_id: financialScoreConvId,
    role: "assistant",
    content: openingMessage
  });

  // Bump the conversation timestamp so it surfaces at the top of the sidebar
  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", financialScoreConvId);

  console.log(`✅ Session saved for: ${clientId} | Score: ${financial_score}/100`);

  const chatLink = `${BASE_URL}/chat/${clientId}`;
  return res.json({ success: true, chatLink });
});

// 📥 Cognito FSA — receive full assessment data, store in Supabase, return chat link
app.post("/api/webhooks/cognito/fsa_record", async (req, res) => {
  const tokenId = req.query.token_id;
  if (tokenId !== process.env.COGNITO_TOKEN_ID) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    console.log("COGNITO RAW BODY:", JSON.stringify(req.body).slice(0, 500));

    const data = req.body || {};
    const f = (path) => cog(data, path);

    const email       = (f("Client1Email") || "").toLowerCase().trim();
    const clientId    = email || "default-user";
    const first_name  = f("Client1Name.First") || f("Client1Name.FirstAndLast")?.split(" ")[0] || "Client";

    const income          = Number(f("TotalMonthlyIncome") ?? 0);
    const debt            = Number(f("EstimatedTotalDebt") ?? 0);
    const savings         = Number(f("CurrentMonthlySavings") ?? 0);
    const financial_score = Number(f("FinancialScores.TOTALFINANCIALSCORE") ?? 0);

    const openingMessage = buildCognitoOpeningMessage(first_name, data);

    await saveSession({
      client_id:        clientId,
      first_name,
      income,
      debt,
      savings,
      financial_score,
      improvement_areas: [],
      cognito_data:     data,
      history:          [{ role: "assistant", content: openingMessage }],
      updated_at:       new Date().toISOString()
    });

    let financialScoreConvId;
    const { data: existingConv } = await supabase
      .from("conversations")
      .select("id")
      .eq("client_id", clientId)
      .eq("is_protected", true)
      .limit(1)
      .single();

    if (existingConv) {
      financialScoreConvId = existingConv.id;
    } else {
      const { data: newConv, error: convError } = await supabase
        .from("conversations")
        .insert({ client_id: clientId, title: "Financial Score", is_protected: true })
        .select()
        .single();
      if (convError || !newConv) {
        console.error("❌ Failed to create Financial Score conversation:", convError);
      } else {
        financialScoreConvId = newConv.id;
      }
    }

    if (financialScoreConvId) {
      await supabase.from("messages").insert({
        conversation_id: financialScoreConvId,
        role:            "assistant",
        content:         openingMessage
      });
      await supabase
        .from("conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", financialScoreConvId);
    }

    console.log(`✅ Cognito session saved: ${clientId} | Score: ${financial_score}/100`);

    // Ping Make to create SuiteDash contact + trigger portal invite
    // Sends full FSA payload so Make has all assessment data available
    if (process.env.MAKE_SUITEDASH_WEBHOOK) {
      fetch(process.env.MAKE_SUITEDASH_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stripNulls({
          // Identity
          email:                       clientId,
          first_name:                  first_name,
          last_name:                   f("Client1Name.Last"),
          full_name:                   f("Client1Name.FirstAndLast"),
          phone:                       f("Client1Phone"),
          state:                       f("StateOfResidence.State"),
          filing_status:               f("FilingStatus"),
          client_age:                  f("ClientAge"),
          dependents:                  f("HowManyDependentsDoYouHave"),
          employment_status:           f("Client1EmploymentStatus"),
          chat_link:                   `${BASE_URL}/chat/${clientId}`,

          // Scores
          total_financial_score:       f("FinancialScores.TOTALFINANCIALSCORE"),
          income_debt_subscore:        f("FinancialScores.IncomeDebtSubscore"),
          investments_subscore:        f("FinancialScores.InvestmentsSubscore"),
          insurance_subscore:          f("InsuranceSubscore"),
          real_estate_subscore:        f("FinancialScores.RealEstateSubscore"),
          retirement_subscore:         f("FinancialScores.RetirementPlanningSubscore"),

          // Income & Cash Flow
          total_monthly_income:        f("TotalMonthlyIncome"),
          total_household_expenses:    f("MonthlyExpenses"),
          monthly_cash_flow:           f("MonthlyCashFlow"),
          current_monthly_savings:     f("CurrentMonthlySavings"),
          savings_rate:                f("SavingsRate"),
          unassigned_cash_flow:        f("UnassignedCashFlow"),
          additional_savings:          f("HowMuchAdditionalMoneyCouldYouSaveEachMonth"),
          tax_deferred_contributions:  f("MonthlyContributionsToTaxDeferredSavings"),
          tax_free_contributions:      f("MonthlyTaxFreeContributions"),
          taxable_contributions:       f("MonthlyContributionsToTaxableAccounts"),

          // Debt
          estimated_total_debt:        f("EstimatedTotalDebt"),
          dti_ratio:                   f("DTIRatio"),
          average_credit_score:        f("AverageCreditScore"),
          client1_credit_score:        f("Client1CreditScore"),
          mortgage_balance:            f("MortgageBalance"),
          credit_card_debt:            f("CreditCardDebt"),
          student_loans:               f("StudentLoans"),
          auto_loans:                  f("AutoLoans"),
          personal_loans:              f("PersonalLoans"),
          heloc:                       f("HomeEquityLoanHELOC"),
          business_loans:              f("BusinessLoans"),
          other_debt:                  f("OtherDebt"),
          good_debt:                   f("GoodDebt"),
          bad_debt:                    f("BadDebt"),
          true_net_worth:              f("TrueNetWorth"),

          // Assets
          estimated_assets_total:      f("EstimatedAssetsTotal"),
          total_gross_assets:          f("TotalGrossAssets"),
          cash_bank_accounts:          f("CashBankAccounts2"),
          total_checking:              f("TotalCheckingAccountBalance"),
          total_savings:               f("TotalSavingsAccountBalance"),
          total_hysa:                  f("TotalHighYieldSavingsAccountBalance"),
          total_money_market:          f("TotalMoneyMarketAccountBalance"),
          total_cd:                    f("TotalCDAccountBalance"),
          real_estate_equity:          f("RealEstateEquity"),
          true_real_estate_equity:     f("TrueRealEstateEquity"),
          primary_residence_equity:    f("PrimaryResidenceEquity"),
          rental_property_equity:      f("RentalPropertyEquity"),
          brokerage_balance:           f("TotalBrokerageAccountBalance"),
          managed_investment:          f("TotalManagedInvestmentBalance"),
          crypto_balance:              f("TotalCryptoExchangeWalletBalance"),
          current_retirement_savings:  f("CurrentRetirementSavings"),
          roth_ira:                    f("RothIRABalance"),
          traditional_ira:             f("TraditionalIRABalance"),
          k401_traditional:            f("_401kTraditionalBalance"),
          k401_roth:                   f("_401kRothBalance"),
          hsa_balance:                 f("HSABalance"),
          pension_balance:             f("PensionDefinedPlanBalance"),
          plan529_balance:             f("_529PlanBalance"),
          other_assets:                f("OtherAssets"),
          total_classified_investable: f("TotalClassifiedInvestableAssets"),
          at_risk_investments:         f("TotalInAtRiskInvestments"),
          non_risk_investments:        f("TotalInNonRiskInvestments"),

          // Tax
          tax_bracket:                 f("TaxBracketPercentage"),
          tax_free_assets:             f("TaxFreeAssets"),
          tax_deferred_assets:         f("TaxDeferredAssets"),
          taxable_assets:              f("TaxableAssets"),
          tax_diversification_note:    f("TaxDiversificationNote"),

          // Insurance
          insurance_score:             f("InsuranceScore"),
          life_insurance_adequacy:     f("LifeInsuranceAdequacyScore"),
          disability_score:            f("DisabilityInsuranceScore"),
          ltc_score:                   f("LTCInsuranceScore"),
          client1_life_insurance:      f("Client1LifeInsurance"),
          client1_insurance_type:      f("Client1LifeInsuranceType"),
          client1_death_benefit:       f("Client1TotalLifeInsuranceDeathBenefit"),
          client1_cash_value:          f("Client1CashValue"),
          client1_disability:          f("Client1DisabilityInsurance"),
          client1_ltc:                 f("Client1LTCInsurance"),

          // Retirement
          desired_retirement_age:      f("Client1DesiredRetirementAge"),
          retirement_goal:             f("Client1RetirementGoal"),
          years_to_retirement:         f("Client1YearsToRetirement"),
          desired_retirement_income:   f("WhatIsYourDesiredMonthlyIncomeAfterRetirement"),
          projected_retirement_assets: f("TotalProjectedRetirementAssets"),
          retirement_shortfall:        f("RetirementIncomeShortfall"),
          total_social_security:       f("TotalEstimatedSocialSecurity"),
          retirement_readiness:        f("RetirementReadinessScore"),
          retirement_summary:          f("RetirementShortfallSummary"),

          // Recommendations
          income_debt_recommendations: f("PlannerNotesIncomeDebts.IncomeDebtsRecommendations"),
          investment_recommendations:  f("PlannerNotesInvestments.InvestmentRecommendation"),
          insurance_recommendations:   f("PlannerNotesInsurance.InsuranceRecommendations"),
          retirement_recommendations:  f("PlannerNotesRetirement.RetirementRecommendations"),
          advisor_notes:               f("AdvisorNotes.AdvisorNotes"),

          // Spouse/Client 2
          client2_name:                f("Client2Name.FirstAndLast"),
          client2_email:               f("Client2Email"),
          client2_phone:               f("Client2Phone"),
          client2_age:                 f("Client2Age"),
          client2_employment:          f("Client2EmploymentStatus")
        }))
      }).catch(err => console.error("❌ Make ping error:", err));
    }

    const chatLink = `${BASE_URL}/chat/${clientId}`;
    return res.json({ success: true, chatLink });

  } catch (err) {
    console.error("❌ Cognito webhook error:", err);
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
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

  // Guarantee the Financial Score conversation exists for every client.
  // Handles clients whose sessions were created before the conversations table,
  // so the sidebar always has at least one entry on first load.
  const { data: existingConv } = await supabase
    .from("conversations")
    .select("id")
    .eq("client_id", clientId)
    .eq("is_protected", true)
    .maybeSingle();

  if (!existingConv) {
    const { data: newConv } = await supabase
      .from("conversations")
      .insert({ client_id: clientId, title: "Financial Score", is_protected: true })
      .select()
      .single();

    if (newConv) {
      await supabase.from("messages").insert({
        conversation_id: newConv.id,
        role: "assistant",
        content: openingMessage
      });
    }
  }

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
    .select("id, title, is_protected, created_at, updated_at")
    .eq("client_id", clientId)
    .order("is_protected", { ascending: false })  // Financial Score always first
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
    .select("client_id, is_protected")
    .eq("id", conversationId)
    .single();

  if (fetchError || !conv) return res.status(404).json({ error: "Conversation not found" });
  if (conv.client_id !== clientId) return res.status(403).json({ error: "Unauthorized" });
  if (conv.is_protected) return res.status(403).json({ error: "This conversation cannot be deleted" });

  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", conversationId);

  if (error) return res.status(500).json({ error: "Failed to delete conversation" });

  res.json({ success: true });
});

// ✏️ Rename a conversation (client must own it, protected conversations excluded)
app.patch("/conversations/:conversationId", async (req, res) => {
  const { conversationId } = req.params;
  const { clientId, title } = req.body;

  if (!clientId || !title?.trim()) return res.status(400).json({ error: "clientId and title required" });

  const { data: conv, error: fetchError } = await supabase
    .from("conversations")
    .select("client_id, is_protected")
    .eq("id", conversationId)
    .single();

  if (fetchError || !conv) return res.status(404).json({ error: "Conversation not found" });
  if (conv.client_id !== clientId) return res.status(403).json({ error: "Unauthorized" });
  if (conv.is_protected) return res.status(403).json({ error: "This conversation cannot be renamed" });

  const { error } = await supabase
    .from("conversations")
    .update({ title: title.trim() })
    .eq("id", conversationId);

  if (error) return res.status(500).json({ error: "Failed to rename conversation" });

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

  const systemPrompt = session.cognito_data
    ? buildCognitoSystemPrompt(session)
    : `You are a financial health advisor AI.

Client context:
Name: ${session.first_name}
Income: $${session.income}
Debt: $${session.debt}
Savings: $${session.savings}
Financial Score: ${session.financial_score}/100
Improvement Areas: ${Array.isArray(session.improvement_areas) && session.improvement_areas.length ? session.improvement_areas.join("; ") : "None"}

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
