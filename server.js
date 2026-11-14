require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const { ChatGroq } = require("@langchain/groq");
const { z } = require("zod");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const client = new MongoClient(process.env.MONGODB_URI);
let db;
let supportTierCap = 500;
const queryVectorCache = new Map();
const FINANCE_LEAD_PIN = (process.env.FINANCE_LEAD_PIN || "1234").trim();

function isValidLeadPin(pin) {
  return String(pin || "").trim() === FINANCE_LEAD_PIN;
}

// Zod Schema enforced by LangChain .withStructuredOutput()
const TicketDecisionSchema = z.object({
  action: z
    .enum(["ISSUE_REFUND", "CHARGE_CUSTOMER", "ADD_ACCOUNT"])
    .describe(
      "ADD_ACCOUNT ONLY when opening a brand-new customer account; CHARGE_CUSTOMER if deducting/charging money; ISSUE_REFUND if crediting/adding funds/refunding."
    ),
  customer_name: z
    .string()
    .nullable()
    .describe(
      "Exact customer name or initials written in the ticket, or null if omitted."
    ),
  target_account: z
    .string()
    .nullable()
    .describe(
      "Account ID like ACCT-101 or ACCT-303 if written in the ticket, or null if omitted."
    ),
  billed_unit_amount: z
    .number()
    .nullable()
    .describe(
      "Single plan/item price if ticket says customer was billed twice/double-charged, else null."
    ),
  is_duplicate_charge: z
    .boolean()
    .describe(
      "True if ticket states customer was billed twice or double-charged."
    ),
  requested_amount: z
    .number()
    .describe(
      "Exact numeric dollar amount to credit, refund, deduct, or set as initial balance for ADD_ACCOUNT."
    ),
  reason: z.string().describe("Short summary of the request"),
  agent_reasoning: z
    .string()
    .describe(
      "1-sentence plain-English explanation of why this action was chosen"
    ),
});

// Batch-capable Voyage AI helper (1 HTTP call for up to 128 texts, 1024 dimensions)
async function embedVoyageBatch(texts, inputType = "document") {
  const voyageKey = (process.env.VOYAGE_API_KEY || "").trim();
  if (!voyageKey || !texts || texts.length === 0) {
    return { vectors: [], error: "VOYAGE_API_KEY is missing or empty in .env" };
  }

  const endpoint = voyageKey.startsWith("al-")
    ? "https://ai.mongodb.com/v1/embeddings"
    : "https://api.voyageai.com/v1/embeddings";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${voyageKey}`,
      },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        model: "voyage-3",
        input: texts,
        input_type: inputType,
      }),
    });
    const data = await res.json();
    if (res.ok && Array.isArray(data?.data)) {
      const vectors = data.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
      return { vectors, model: "voyage-3", error: null };
    }
    return {
      vectors: [],
      error: `Voyage AI HTTP ${res.status}: ${
        data?.detail || data?.message || JSON.stringify(data)
      }`,
    };
  } catch (err) {
    return { vectors: [], error: `Voyage AI network error: ${err.message}` };
  }
}

// Helper: Write audit entry to MongoDB with deduplicated customer name + Voyage AI embedding
async function recordAuditEntry(entry) {
  let customerName = (entry.customer_name || "").trim();
  if (
    (!customerName ||
      customerName.toUpperCase() ===
        (entry.target_account || "").toUpperCase()) &&
    entry.target_account &&
    entry.target_account !== "UNKNOWN"
  ) {
    const acct = await db
      .collection("customer_accounts")
      .findOne({ account_id: entry.target_account });
    customerName = acct ? acct.customer : "";
  }

  const custPart =
    customerName &&
    customerName.toUpperCase() !== (entry.target_account || "").toUpperCase()
      ? ` (${customerName})`
      : "";

  const textToEmbed = `${entry.status} | ${entry.action} $${entry.amount} on ${
    entry.target_account
  }${custPart} | Role: ${entry.authorized_by} | Reason: ${
    entry.reason
  } | Reasoning: ${entry.agent_reasoning || ""} | Verdict: ${
    entry.policy_verdict || ""
  }`;
  const { vectors } = await embedVoyageBatch([textToEmbed], "document");

  await db.collection("audit_ledger").insertOne({
    ...entry,
    ...(customerName ? { customer_name: customerName } : {}),
    ...(vectors[0] ? { audit_embedding: vectors[0] } : {}),
  });
}

// Helper: Re-embed an audit entry after rollback actor & reason are recorded
async function refreshAuditEmbedding(entryId) {
  const updated = await db.collection("audit_ledger").findOne({ _id: entryId });
  if (!updated) return;

  const rollbackNote = updated.rolled_back_by
    ? ` | Rolled back by: ${updated.rolled_back_by} (Rollback reason: ${
        updated.rollback_reason || "Operator rollback"
      })`
    : "";
  const custPart =
    updated.customer_name &&
    updated.customer_name.toUpperCase() !==
      (updated.target_account || "").toUpperCase()
      ? ` (${updated.customer_name})`
      : "";

  const textToEmbed = `${updated.status} | ${updated.action} $${
    updated.amount
  } on ${updated.target_account}${custPart} | Role: ${
    updated.authorized_by
  }${rollbackNote} | Reason: ${updated.reason} | Reasoning: ${
    updated.agent_reasoning || ""
  } | Verdict: ${updated.policy_verdict || ""}`;
  const { vectors } = await embedVoyageBatch([textToEmbed], "document");
  if (vectors[0]) {
    await db
      .collection("audit_ledger")
      .updateOne({ _id: entryId }, { $set: { audit_embedding: vectors[0] } });
  }
}

// Helper: Auto-generate next ACCT-XXX ID if none was specified
async function generateNextAccountId() {
  const accounts = await db.collection("customer_accounts").find({}).toArray();
  const pending = await db
    .collection("escalation_requests")
    .find({ status: "PENDING", request_type: "ADD_ACCOUNT" })
    .toArray();

  let maxNum = 100;
  for (const item of [...accounts, ...pending]) {
    const idStr = item.account_id || item.target_account || "";
    const match = idStr.match(/^ACCT-(\d+)$/i);
    if (match) {
      maxNum = Math.max(maxNum, Number(match[1]));
    }
  }
  return `ACCT-${maxNum + 1}`;
}

// Shared Account Creation Governance (used by both "+ Add Account" form and AI Ticket Agent)
async function processAddAccount({
  trace_id,
  agent_id,
  authorized_by,
  lead_pin,
  account_id,
  customer_name,
  initial_balance,
  reason,
  agent_reasoning,
}) {
  const cleanName = (customer_name || "").trim();
  const cleanId =
    (account_id || "").trim().toUpperCase() || (await generateNextAccountId());
  const balanceNum = Number(initial_balance);

  if (!cleanName || !Number.isFinite(balanceNum) || balanceNum < 0) {
    const policy_verdict =
      "Blocked: Provide a valid customer name and non-negative initial balance.";
    return {
      httpStatus: 400,
      status: "BLOCKED",
      allowed: false,
      policy_verdict,
      summary: policy_verdict,
    };
  }

  // 1. Block unauthorized roles
  if (!["support_tier_1", "finance_lead"].includes(authorized_by)) {
    const policy_verdict = `Blocked: Role "${authorized_by}" is not permitted to create customer accounts.`;
    await recordAuditEntry({
      trace_id,
      agent_id: agent_id || "gatekeeper-account-portal",
      authorized_by,
      action: "ADD_ACCOUNT",
      amount: balanceNum,
      target_account: cleanId,
      customer_name: cleanName,
      reason: reason || `Create account for ${cleanName}`,
      agent_reasoning:
        agent_reasoning ||
        `Attempted to onboard customer account ${cleanId} (${cleanName}) with $${balanceNum}.`,
      policy_cap_at_execution: supportTierCap,
      policy_verdict,
      status: "BLOCKED_BY_DB_POLICY",
      blocked_at: new Date(),
    });
    return {
      httpStatus: 403,
      status: "BLOCKED",
      allowed: false,
      policy_verdict,
      summary: policy_verdict,
    };
  }

  // 2. Check duplicate Account ID
  const existing = await db
    .collection("customer_accounts")
    .findOne({ account_id: cleanId });
  if (existing) {
    const policy_verdict = `Blocked: Account "${cleanId}" already exists (${existing.customer}).`;
    return {
      httpStatus: 409,
      status: "BLOCKED",
      allowed: false,
      policy_verdict,
      summary: policy_verdict,
    };
  }

  // 3. support_tier_1 -> route to finance_lead approval queue
  if (authorized_by === "support_tier_1") {
    const finalReason =
      (reason || "").trim() || `New customer onboarding: ${cleanName}`;
    const finalReasoning =
      agent_reasoning ||
      `Support staff requested creating account ${cleanId} (${cleanName}) with initial balance $${balanceNum}.`;

    const escDoc = {
      request_type: "ADD_ACCOUNT",
      trace_id,
      agent_id: agent_id || "gatekeeper-account-portal",
      requested_by: "support_tier_1",
      action: "ADD_ACCOUNT",
      amount: balanceNum,
      target_account: cleanId,
      customer_name: cleanName,
      reason: finalReason,
      agent_reasoning: finalReasoning,
      cap_at_request: supportTierCap,
      status: "PENDING",
      created_at: new Date(),
    };

    const result = await db.collection("escalation_requests").insertOne(escDoc);
    const policy_verdict = `Escalated by support_tier_1 to finance_lead queue (new account creation requires lead approval).`;

    await recordAuditEntry({
      trace_id,
      agent_id: escDoc.agent_id,
      authorized_by: "support_tier_1",
      action: "ADD_ACCOUNT",
      amount: balanceNum,
      target_account: cleanId,
      customer_name: cleanName,
      reason: finalReason,
      agent_reasoning: finalReasoning,
      policy_cap_at_execution: supportTierCap,
      policy_verdict,
      status: "ESCALATED_PENDING",
      created_at: new Date(),
    });

    const summary = `Account creation request for ${cleanName} (${cleanId}, $${balanceNum}) sent to finance_lead approval queue.`;
    return {
      httpStatus: 200,
      status: "ESCALATED_PENDING",
      allowed: false,
      escalation_id: result.insertedId,
      policy_verdict,
      summary,
    };
  }

  // 4. finance_lead -> verify PIN and create directly
  if (!isValidLeadPin(lead_pin)) {
    const policy_verdict =
      "Blocked: Valid finance_lead PIN required to create an account directly.";
    return {
      httpStatus: 401,
      status: "BLOCKED",
      allowed: false,
      policy_verdict,
      summary: policy_verdict,
    };
  }

  await db.collection("customer_accounts").insertOne({
    account_id: cleanId,
    customer: cleanName,
    balance: balanceNum,
    created_by: "finance_lead",
    created_at: new Date(),
  });

  const policy_verdict = `Approved: "finance_lead" directly created customer account ${cleanId} (${cleanName}).`;
  await recordAuditEntry({
    trace_id,
    agent_id: agent_id || "gatekeeper-account-portal",
    authorized_by: "finance_lead",
    action: "ADD_ACCOUNT",
    amount: balanceNum,
    target_account: cleanId,
    customer_name: cleanName,
    reason: (reason || "").trim() || `Direct account creation by finance_lead`,
    agent_reasoning:
      agent_reasoning ||
      `finance_lead onboarded ${cleanName} (${cleanId}) with initial balance $${balanceNum}.`,
    policy_cap_at_execution: null,
    policy_verdict,
    pre_state: { balance: 0 },
    post_state: { balance: balanceNum },
    status: "COMMITTED",
    executed_at: new Date(),
  });

  const summary = `Account ${cleanId} (${cleanName}) created with initial balance $${balanceNum}.`;
  return {
    httpStatus: 200,
    status: "EXECUTED",
    allowed: true,
    policy_verdict,
    summary,
  };
}

// MongoDB $jsonSchema policy gate
function buildPolicyValidator(cap) {
  return {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "trace_id",
        "agent_id",
        "authorized_by",
        "action",
        "amount",
        "target_account",
        "status",
        "created_at",
      ],
      properties: {
        trace_id: { bsonType: "string" },
        agent_id: { bsonType: "string" },
        authorized_by: {
          bsonType: "string",
          enum: ["support_tier_1", "finance_lead"],
        },
        action: {
          bsonType: "string",
          enum: ["ISSUE_REFUND", "CHARGE_CUSTOMER"],
        },
        amount: { bsonType: ["int", "double"], minimum: 0.01 },
        target_account: { bsonType: "string" },
        reason: { bsonType: "string" },
        agent_reasoning: { bsonType: "string" },
        status: {
          bsonType: "string",
          enum: ["VALIDATED_INTENT", "EXECUTED", "ROLLED_BACK"],
        },
        created_at: { bsonType: "date" },
      },
      oneOf: [
        {
          properties: {
            authorized_by: { enum: ["support_tier_1"] },
            amount: { maximum: cap },
          },
        },
        {
          properties: {
            authorized_by: { enum: ["finance_lead"] },
          },
        },
      ],
    },
  };
}

async function applyPolicyValidator(cap) {
  await db.command({
    collMod: "action_intents",
    validator: buildPolicyValidator(cap),
    validationLevel: "strict",
    validationAction: "error",
  });
}

function attachChangeStream() {
  const intentsCol = db.collection("action_intents");
  const accountsCol = db.collection("customer_accounts");
  const runsCol = db.collection("agent_runs");

  const changeStream = intentsCol.watch([
    { $match: { operationType: "insert" } },
  ]);

  changeStream.on("change", async (change) => {
    const intent = change.fullDocument;
    console.log(
      `⚡ Change Stream picked up validated intent ${intent._id} (${intent.action} $${intent.amount})`
    );

    const run = await runsCol.findOne({ trace_id: intent.trace_id });
    if (run && run.aborted) {
      console.log(`🛑 Run ${intent.trace_id} is ABORTED. Skipping execution.`);
      return;
    }

    const accountBefore = await accountsCol.findOne({
      account_id: intent.target_account,
    });
    if (!accountBefore) return;

    const signedDelta =
      intent.action === "CHARGE_CUSTOMER" ? -intent.amount : intent.amount;
    const newBalance = Number((accountBefore.balance + signedDelta).toFixed(2));

    await accountsCol.updateOne(
      { account_id: intent.target_account },
      { $set: { balance: newBalance } }
    );

    await intentsCol.updateOne(
      { _id: intent._id },
      { $set: { status: "EXECUTED" } }
    );

    const approvalNote = intent.escalated_from
      ? `Approved by finance_lead (escalated from ${intent.escalated_from} because $${intent.amount} exceeded the $${supportTierCap} limit).`
      : intent.authorized_by === "finance_lead"
      ? `Approved: "finance_lead" has unlimited spending authority.`
      : `Approved: "${intent.authorized_by}" is an authorized role and $${intent.amount} is within the $${supportTierCap} spending limit.`;

    await recordAuditEntry({
      intent_id: intent._id,
      trace_id: intent.trace_id,
      agent_id: intent.agent_id,
      authorized_by: intent.authorized_by,
      escalated_from: intent.escalated_from || null,
      action: intent.action,
      amount: intent.amount,
      target_account: intent.target_account,
      customer_name: accountBefore.customer,
      reason: intent.reason,
      agent_reasoning: intent.agent_reasoning || "Direct policy execution",
      policy_cap_at_execution:
        intent.authorized_by === "finance_lead" ? null : supportTierCap,
      policy_verdict: approvalNote,
      pre_state: { balance: accountBefore.balance },
      post_state: { balance: newBalance },
      inverse_operation: {
        collection: "customer_accounts",
        filter: { account_id: intent.target_account },
        delta: -signedDelta,
      },
      status: "COMMITTED",
      executed_at: new Date(),
    });

    console.log(
      `✅ Executed & logged: ${intent.action} $${intent.amount} on ${intent.target_account} ($${accountBefore.balance} -> $${newBalance})`
    );
  });

  changeStream.on("error", () => setTimeout(attachChangeStream, 1000));
  changeStream.on("close", () => setTimeout(attachChangeStream, 1000));
}

async function startWorker() {
  await client.connect();
  db = client.db("gatekeeper_db");
  console.log("✅ Connected to MongoDB Atlas Sandbox");
  await applyPolicyValidator(supportTierCap);
  attachChangeStream();
}

function formatPolicyVerdict(doc, cap) {
  if (!["support_tier_1", "finance_lead"].includes(doc.authorized_by)) {
    return `Blocked: Role "${doc.authorized_by}" is not permitted to issue refunds or charges.`;
  }
  if (doc.authorized_by === "support_tier_1" && doc.amount > cap) {
    return `Blocked: $${doc.amount} exceeds the $${cap} spending limit for "support_tier_1". Finance lead approval is required.`;
  }
  return `Blocked: Transaction violated active spending or role policy rules.`;
}

async function submitIntentToMongo({
  trace_id,
  agent_id,
  authorized_by,
  escalated_from,
  action,
  amount,
  target_account,
  reason,
  agent_reasoning,
}) {
  await db
    .collection("agent_runs")
    .updateOne(
      { trace_id },
      { $setOnInsert: { trace_id, aborted: false, started_at: new Date() } },
      { upsert: true }
    );

  const numericAmount = Number(amount);
  const normalizedAction =
    action === "CHARGE_CUSTOMER" ? "CHARGE_CUSTOMER" : "ISSUE_REFUND";

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    const policy_verdict = `Blocked: Invalid amount ($${amount}). Amount must be greater than $0.`;
    await recordAuditEntry({
      trace_id,
      agent_id: agent_id || "langchain-groq-agent",
      authorized_by,
      action: normalizedAction,
      amount: Number.isFinite(numericAmount) ? numericAmount : 0,
      target_account: target_account || "UNKNOWN",
      reason: reason || "Invalid amount",
      agent_reasoning: agent_reasoning || "",
      policy_cap_at_execution:
        authorized_by === "finance_lead" ? null : supportTierCap,
      policy_verdict,
      status: "BLOCKED_BY_DB_POLICY",
      blocked_at: new Date(),
    });
    return { allowed: false, policy_verdict, summary: policy_verdict };
  }

  const targetAcctDoc = await db
    .collection("customer_accounts")
    .findOne({ account_id: target_account });
  if (!targetAcctDoc) {
    const policy_verdict = `Blocked: Account "${target_account}" does not exist.`;
    return { allowed: false, policy_verdict, summary: policy_verdict };
  }
  if (
    normalizedAction === "CHARGE_CUSTOMER" &&
    targetAcctDoc.balance < numericAmount
  ) {
    const policy_verdict = `Blocked: Insufficient balance on ${target_account} ($${targetAcctDoc.balance}) to deduct $${numericAmount}.`;
    await recordAuditEntry({
      trace_id,
      agent_id: agent_id || "langchain-groq-agent",
      authorized_by,
      action: normalizedAction,
      amount: numericAmount,
      target_account,
      customer_name: targetAcctDoc.customer,
      reason: reason || "Insufficient balance",
      agent_reasoning: agent_reasoning || "",
      policy_cap_at_execution:
        authorized_by === "finance_lead" ? null : supportTierCap,
      policy_verdict,
      status: "BLOCKED_BY_DB_POLICY",
      blocked_at: new Date(),
    });
    return { allowed: false, policy_verdict, summary: policy_verdict };
  }

  const doc = {
    trace_id,
    agent_id: agent_id || "langchain-groq-agent",
    authorized_by,
    ...(escalated_from ? { escalated_from } : {}),
    action: normalizedAction,
    amount: numericAmount,
    target_account,
    reason: reason || "Customer support ticket resolution",
    agent_reasoning: agent_reasoning || "",
    status: "VALIDATED_INTENT",
    created_at: new Date(),
  };

  try {
    const result = await db.collection("action_intents").insertOne(doc);
    const verb =
      normalizedAction === "CHARGE_CUSTOMER" ? "Deducted" : "Credited";
    const prep = normalizedAction === "CHARGE_CUSTOMER" ? "from" : "to";
    const policy_verdict = escalated_from
      ? `Approved by finance_lead (escalated from ${escalated_from} because $${doc.amount} exceeded the $${supportTierCap} limit).`
      : authorized_by === "finance_lead"
      ? `Approved: "finance_lead" has unlimited spending authority.`
      : `Approved: "${authorized_by}" is an authorized role and $${doc.amount} is within the $${supportTierCap} spending limit.`;

    return {
      allowed: true,
      intent_id: result.insertedId,
      policy_verdict,
      summary: `${verb} $${doc.amount} ${prep} ${doc.target_account} (${targetAcctDoc.customer}).`,
      proposed_intent: doc,
    };
  } catch (err) {
    const policy_verdict = formatPolicyVerdict(doc, supportTierCap);
    const canEscalate =
      doc.authorized_by === "support_tier_1" && doc.amount > supportTierCap;

    await recordAuditEntry({
      trace_id,
      agent_id: doc.agent_id,
      authorized_by: doc.authorized_by,
      action: doc.action,
      amount: doc.amount,
      target_account: doc.target_account,
      customer_name: targetAcctDoc.customer,
      reason: doc.reason,
      agent_reasoning: doc.agent_reasoning,
      policy_cap_at_execution: supportTierCap,
      policy_verdict,
      status: "BLOCKED_BY_DB_POLICY",
      db_error: err.message,
      blocked_at: new Date(),
    });

    return {
      allowed: false,
      can_escalate_to_finance: canEscalate,
      policy_verdict,
      summary: policy_verdict,
      proposed_intent: {
        ...doc,
        customer_name: targetAcctDoc.customer,
      },
      details: err.errInfo || err.message,
    };
  }
}

async function callAgentLLM(prompt, ticketText = "") {
  const groqKey = process.env.GROQ_API_KEY;

  if (groqKey) {
    const candidateModels = [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "llama-3.1-8b-instant",
    ];
    for (const modelName of candidateModels) {
      try {
        console.log(`🦜🔗 Calling LangChain ChatGroq (${modelName})...`);
        const llm = new ChatGroq({
          apiKey: groqKey,
          model: modelName,
          temperature: 0,
          maxRetries: 1,
        }).withStructuredOutput(TicketDecisionSchema);

        const decision = await llm.invoke(prompt);
        return {
          model: `langchain/groq/${modelName}`,
          decision,
        };
      } catch (err) {
        console.log(`⚠️ LangChain ChatGroq (${modelName}) error:`, err.message);
      }
    }
  }

  const isAddAccount =
    /\b(add|create|open|onboard)\s+(?:a\s+|new\s+)?account\b/i.test(ticketText);
  const isCharge =
    !isAddAccount &&
    /\b(charge|deduct|debit|bill)\b/i.test(ticketText) &&
    !/\brefund\b/i.test(ticketText);
  const amountMatches = [
    ...ticketText.matchAll(
      /(-?\$|\$-?)\s*(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s*dollars?\b/gi
    ),
  ];
  const parsedAmounts = amountMatches.map((m) =>
    m[3] ? Number(m[3]) : (m[1].includes("-") ? -1 : 1) * Number(m[2])
  );
  const requestedAmount = parsedAmounts.length
    ? parsedAmounts[parsedAmounts.length - 1]
    : isAddAccount
    ? 0
    : 50;
  const billedUnitAmount = parsedAmounts.length > 1 ? parsedAmounts[0] : null;
  const acctMatch = ticketText.match(/ACCT-\d+/i);

  let parsedName = /bob/i.test(ticketText)
    ? "Bob Patel"
    : /alice/i.test(ticketText)
    ? "Alice Chen"
    : null;
  if (isAddAccount) {
    const nameMatch = ticketText.match(
      /account\s+(?:for\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/
    );
    if (nameMatch) parsedName = nameMatch[1].trim();
  }

  return {
    model: "deterministic-fallback",
    decision: {
      action: isAddAccount
        ? "ADD_ACCOUNT"
        : isCharge
        ? "CHARGE_CUSTOMER"
        : "ISSUE_REFUND",
      customer_name: parsedName,
      target_account: acctMatch ? acctMatch[0].toUpperCase() : null,
      billed_unit_amount: billedUnitAmount,
      is_duplicate_charge: /twice|double|duplicate/i.test(ticketText),
      requested_amount: requestedAmount,
      reason: isAddAccount
        ? `New customer onboarding: ${parsedName || "Customer"}`
        : isCharge
        ? "Customer account charge/deduction"
        : "Customer credit/refund request",
      agent_reasoning: isAddAccount
        ? `Parsed request to create customer account for ${
            parsedName || "customer"
          } with $${requestedAmount} balance.`
        : `Parsed ${isCharge ? "deduction" : "credit"} of $${requestedAmount}.`,
    },
  };
}

// Endpoint 0: Verify finance_lead PIN
app.post("/api/auth/verify-lead", (req, res) => {
  const { pin } = req.body;
  if (!isValidLeadPin(pin)) {
    return res
      .status(401)
      .json({ valid: false, error: "Incorrect PIN for finance_lead." });
  }
  return res.json({ valid: true, message: "finance_lead session unlocked." });
});

// Endpoint 0B: Create New Customer Account via "+ Add Account" form
app.post("/api/accounts", async (req, res) => {
  const {
    trace_id,
    authorized_by,
    lead_pin,
    account_id,
    customer_name,
    initial_balance,
    reason,
  } = req.body;

  const outcome = await processAddAccount({
    trace_id,
    agent_id: "gatekeeper-account-portal",
    authorized_by,
    lead_pin,
    account_id,
    customer_name,
    initial_balance,
    reason,
  });

  if (outcome.status === "BLOCKED") {
    return res
      .status(outcome.httpStatus)
      .json({ status: "BLOCKED", error: outcome.policy_verdict });
  }

  return res.status(200).json({
    status: outcome.status,
    escalation_id: outcome.escalation_id,
    message: outcome.summary,
  });
});

// Endpoint 1: Analyze ticket, enforce confirmations, or run MongoDB policy gate
app.post("/api/agent/ticket", async (req, res) => {
  const { trace_id, authorized_by, lead_pin, ticket_text } = req.body;

  if (authorized_by === "finance_lead" && !isValidLeadPin(lead_pin)) {
    return res
      .status(401)
      .json({ error: "Invalid or missing finance_lead PIN." });
  }

  if (!ticket_text || !ticket_text.trim()) {
    return res.status(400).json({ error: "Ticket text cannot be empty." });
  }

  const accounts = await db.collection("customer_accounts").find({}).toArray();
  const accountListText = accounts
    .map((a) => `- ${a.account_id}: ${a.customer}`)
    .join("\n");

  const prompt = `You are a financial support operations agent. Extract structured fields from the customer ticket below.
Existing database accounts:
${accountListText}

Ticket: "${ticket_text}"

Rules:
1. "action":
   - Set to "ADD_ACCOUNT" ONLY when explicitly opening/creating a brand-new customer account for someone NOT in the existing database accounts list.
   - Set to "ISSUE_REFUND" when adding money, funds, credit, or a refund to an EXISTING customer's balance (e.g. "Add amount 1000 dollars to Danny").
   - Set to "CHARGE_CUSTOMER" when charging, deducting, or debiting money from an existing customer.
2. "requested_amount":
   - For "ADD_ACCOUNT": the initial account balance (default 0 if not mentioned).
   - For "ISSUE_REFUND" or "CHARGE_CUSTOMER": the exact numeric dollar amount to credit or deduct.
3. "billed_unit_amount" & "is_duplicate_charge": If the ticket says the customer was billed twice / double-charged for a plan/item price (e.g. "$60 pro plan"), set "billed_unit_amount" to that single charge (60) and "is_duplicate_charge" to true. Otherwise null and false.
4. "customer_name": Extract the exact customer name written in the ticket (e.g. "Danny" or "AB"), or null if no name is written.
5. "target_account": Extract the ACCT-XXX ID if written in the ticket, or null if not written.`;

  try {
    const { model, decision } = await callAgentLLM(prompt, ticket_text);
    const requestedAmount = Number(decision.requested_amount);
    const billedUnit =
      decision.billed_unit_amount !== null
        ? Number(decision.billed_unit_amount)
        : null;
    let action = ["ISSUE_REFUND", "CHARGE_CUSTOMER", "ADD_ACCOUNT"].includes(
      decision.action
    )
      ? decision.action
      : "ISSUE_REFUND";

    // Guardrail: If LLM outputs ADD_ACCOUNT for an existing customer, credit their existing account instead
    if (action === "ADD_ACCOUNT") {
      const rawName = (decision.customer_name || "").trim();
      const existingById = decision.target_account
        ? accounts.find(
            (a) =>
              a.account_id.toUpperCase() ===
              decision.target_account.toUpperCase()
          )
        : null;
      const existingByName = rawName
        ? accounts.find((a) => {
            const full = a.customer.toLowerCase();
            const q = rawName.toLowerCase();
            return (
              q.length >= 3 && (full === q || full.split(/\s+/).includes(q))
            );
          })
        : null;

      const existingCustomer = existingById || existingByName;
      if (existingCustomer) {
        action = "ISSUE_REFUND";
        decision.action = "ISSUE_REFUND";
        decision.target_account = existingCustomer.account_id;
      }
    }

    // 0. Brand-new ADD_ACCOUNT ticket -> route through shared role & PIN governance
    if (action === "ADD_ACCOUNT") {
      const outcome = await processAddAccount({
        trace_id,
        agent_id: model,
        authorized_by,
        lead_pin,
        account_id: decision.target_account,
        customer_name: decision.customer_name,
        initial_balance: requestedAmount,
        reason: decision.reason,
        agent_reasoning: decision.agent_reasoning,
      });

      return res.status(outcome.httpStatus).json({
        status: outcome.status,
        model_used: model,
        llm_decision: decision,
        mongodb_gate_result: {
          allowed: outcome.allowed,
          policy_verdict: outcome.policy_verdict,
          summary: outcome.summary,
        },
      });
    }

    // 1. Edge case: Negative, zero, or non-numeric amount for refunds/charges
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      const outcome = await submitIntentToMongo({
        trace_id,
        agent_id: model,
        authorized_by,
        action,
        amount: requestedAmount,
        target_account: decision.target_account || "UNKNOWN",
        reason: decision.reason,
        agent_reasoning: decision.agent_reasoning,
      });
      return res.status(400).json({
        status: "BLOCKED",
        model_used: model,
        llm_decision: decision,
        mongodb_gate_result: outcome,
      });
    }

    // 2. Strict Customer Name vs. Account ID verification
    const byId = decision.target_account
      ? accounts.find(
          (a) =>
            a.account_id.toUpperCase() === decision.target_account.toUpperCase()
        )
      : null;

    const rawName = (decision.customer_name || "").trim();
    const byName = rawName
      ? accounts.find((a) => {
          const full = a.customer.toLowerCase();
          const query = rawName.toLowerCase();
          return (
            query.length >= 3 &&
            (full === query || full.split(" ").includes(query))
          );
        })
      : null;

    if (rawName && !byName) {
      const suggestedAcct = byId || accounts[0];
      return res.status(200).json({
        status: "NEEDS_CONFIRMATION",
        confirmation_type: "UNKNOWN_CUSTOMER_NAME",
        model_used: model,
        message: `Unrecognized customer name "${rawName}"${
          byId ? ` paired with ${byId.account_id} (${byId.customer})` : ""
        }. Confirm which existing customer account should be used:`,
        options: accounts.map((a) => ({
          label: `${action === "CHARGE_CUSTOMER" ? "Charge" : "Credit"} ${
            a.customer
          } (${a.account_id})`,
          target_account: a.account_id,
          amount: requestedAmount,
        })),
        pending_intent: {
          trace_id,
          agent_id: model,
          authorized_by,
          action,
          amount: requestedAmount,
          target_account: suggestedAcct.account_id,
          reason: decision.reason,
          agent_reasoning: decision.agent_reasoning,
        },
      });
    }

    if (byName && byId && byName.account_id !== byId.account_id) {
      return res.status(200).json({
        status: "NEEDS_CONFIRMATION",
        confirmation_type: "IDENTITY_MISMATCH",
        model_used: model,
        message: `Account mismatch: Ticket mentions "${byName.customer}" (${byName.account_id}), but specified account ID "${byId.account_id}" belongs to ${byId.customer}. Which account should be used?`,
        options: [
          {
            label: `${action === "CHARGE_CUSTOMER" ? "Charge" : "Credit"} ${
              byName.customer
            } (${byName.account_id})`,
            target_account: byName.account_id,
            amount: requestedAmount,
          },
          {
            label: `${action === "CHARGE_CUSTOMER" ? "Charge" : "Credit"} ${
              byId.customer
            } (${byId.account_id})`,
            target_account: byId.account_id,
            amount: requestedAmount,
          },
        ],
        pending_intent: {
          trace_id,
          agent_id: model,
          authorized_by,
          action,
          amount: requestedAmount,
          target_account: byName.account_id,
          reason: decision.reason,
          agent_reasoning: decision.agent_reasoning,
        },
      });
    }

    const resolvedAccountDoc = byId || byName;
    if (!resolvedAccountDoc) {
      const policy_verdict = `Blocked: Target account "${
        decision.target_account || "none"
      }" was not found.`;
      return res.status(404).json({
        status: "BLOCKED",
        model_used: model,
        llm_decision: decision,
        mongodb_gate_result: {
          allowed: false,
          policy_verdict,
          summary: policy_verdict,
        },
      });
    }

    // 3. Deduction / Customer Charge ALWAYS requires human confirmation + explicit reason
    if (action === "CHARGE_CUSTOMER") {
      return res.status(200).json({
        status: "NEEDS_CONFIRMATION",
        confirmation_type: "CHARGE_REQUIRES_REASON",
        require_reason: true,
        model_used: model,
        message: `Deduction Alert: This ticket requests charging/deducting $${requestedAmount} from ${resolvedAccountDoc.customer} (${resolvedAccountDoc.account_id}, current balance: $${resolvedAccountDoc.balance}). Enter an audit reason and confirm:`,
        options: [
          {
            label: `Confirm Deduction of $${requestedAmount} from ${resolvedAccountDoc.customer}`,
            target_account: resolvedAccountDoc.account_id,
            amount: requestedAmount,
          },
        ],
        pending_intent: {
          trace_id,
          agent_id: model,
          authorized_by,
          action: "CHARGE_CUSTOMER",
          amount: requestedAmount,
          target_account: resolvedAccountDoc.account_id,
          reason: decision.reason,
          agent_reasoning: decision.agent_reasoning,
        },
      });
    }

    // 4. Duplicate charge discrepancy check
    if (
      decision.is_duplicate_charge &&
      billedUnit &&
      billedUnit > 0 &&
      requestedAmount !== billedUnit
    ) {
      return res.status(200).json({
        status: "NEEDS_CONFIRMATION",
        confirmation_type: "AMOUNT_DISCREPANCY",
        model_used: model,
        message: `Refund discrepancy detected: ${resolvedAccountDoc.customer} (${resolvedAccountDoc.account_id}) was billed twice for a $${billedUnit} plan (expected duplicate refund is $${billedUnit}), but the ticket requests $${requestedAmount}. Confirm the correct refund amount:`,
        options: [
          {
            label: `Revert to $${billedUnit} (Correct Duplicate Refund)`,
            target_account: resolvedAccountDoc.account_id,
            amount: billedUnit,
          },
          {
            label: `Proceed with Requested $${requestedAmount}`,
            target_account: resolvedAccountDoc.account_id,
            amount: requestedAmount,
          },
        ],
        pending_intent: {
          trace_id,
          agent_id: model,
          authorized_by,
          action: "ISSUE_REFUND",
          amount: billedUnit,
          target_account: resolvedAccountDoc.account_id,
          reason: decision.reason,
          agent_reasoning: decision.agent_reasoning,
        },
      });
    }

    // 5. Submit to MongoDB $jsonSchema policy gate
    const outcome = await submitIntentToMongo({
      trace_id,
      agent_id: model,
      authorized_by,
      action,
      amount: requestedAmount,
      target_account: resolvedAccountDoc.account_id,
      reason: decision.reason,
      agent_reasoning: decision.agent_reasoning,
    });

    res.status(outcome.allowed ? 200 : 403).json({
      status: outcome.allowed ? "EXECUTED" : "BLOCKED",
      model_used: model,
      llm_decision: decision,
      mongodb_gate_result: outcome,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint 2: Execute operator-confirmed resolution
app.post("/api/agent/confirm", async (req, res) => {
  const {
    trace_id,
    agent_id,
    authorized_by,
    lead_pin,
    action,
    amount,
    target_account,
    reason,
    agent_reasoning,
    operator_reason,
  } = req.body;

  if (authorized_by === "finance_lead" && !isValidLeadPin(lead_pin)) {
    return res
      .status(401)
      .json({ error: "Invalid or missing finance_lead PIN." });
  }

  const finalReason = operator_reason ? operator_reason.trim() : reason;
  const note = `${agent_reasoning} (Operator confirmed: ${
    finalReason || `$${amount} on ${target_account}`
  })`;

  const outcome = await submitIntentToMongo({
    trace_id,
    agent_id,
    authorized_by,
    action: action || "ISSUE_REFUND",
    amount: Number(amount),
    target_account,
    reason: finalReason,
    agent_reasoning: note,
  });

  res.status(outcome.allowed ? 200 : 403).json({
    status: outcome.allowed ? "EXECUTED" : "BLOCKED",
    model_used: agent_id,
    mongodb_gate_result: outcome,
  });
});

// Endpoint 2B: Queue a PENDING escalation request (Over-Cap Transaction) for finance_lead review
app.post("/api/escalations", async (req, res) => {
  const {
    trace_id,
    agent_id,
    requested_by,
    action,
    amount,
    target_account,
    customer_name,
    reason,
    agent_reasoning,
  } = req.body;

  let resolvedCustomerName = (customer_name || "").trim();
  if (
    !resolvedCustomerName ||
    resolvedCustomerName.toUpperCase() === (target_account || "").toUpperCase()
  ) {
    const acctDoc = await db
      .collection("customer_accounts")
      .findOne({ account_id: target_account });
    resolvedCustomerName = acctDoc ? acctDoc.customer : "";
  }

  const escDoc = {
    request_type: "TRANSACTION",
    trace_id,
    agent_id: agent_id || "langchain-groq-agent",
    requested_by: requested_by || "support_tier_1",
    action: action || "ISSUE_REFUND",
    amount: Number(amount),
    target_account,
    customer_name: resolvedCustomerName,
    reason: reason || "Over-cap refund escalation",
    agent_reasoning: agent_reasoning || "",
    cap_at_request: supportTierCap,
    status: "PENDING",
    created_at: new Date(),
  };

  const result = await db.collection("escalation_requests").insertOne(escDoc);

  await recordAuditEntry({
    trace_id,
    agent_id: escDoc.agent_id,
    authorized_by: escDoc.requested_by,
    action: escDoc.action,
    amount: escDoc.amount,
    target_account: escDoc.target_account,
    customer_name: resolvedCustomerName,
    reason: escDoc.reason,
    agent_reasoning: escDoc.agent_reasoning,
    policy_cap_at_execution: supportTierCap,
    policy_verdict: `Escalated by ${escDoc.requested_by} to finance_lead queue (awaiting lead approval).`,
    status: "ESCALATED_PENDING",
    created_at: new Date(),
  });

  res.json({
    queued: true,
    escalation_id: result.insertedId,
    message: `Escalation request for $${escDoc.amount} (${escDoc.target_account}) sent to finance_lead approval queue. Switch role to finance_lead to review.`,
  });
});

// Endpoint 2C: finance_lead approves or rejects ANY queued escalation (Over-Cap Transaction OR Add Account)
app.post("/api/escalations/:id/resolve", async (req, res) => {
  const { id } = req.params;
  const { decision, authorized_by, lead_pin, lead_note } = req.body;

  if (authorized_by !== "finance_lead" || !isValidLeadPin(lead_pin)) {
    return res.status(403).json({
      error: `Unauthorized: Valid "finance_lead" role and PIN are required to approve or reject requests.`,
    });
  }

  const esc = await db
    .collection("escalation_requests")
    .findOne({ _id: new ObjectId(id) });
  if (!esc || esc.status !== "PENDING") {
    return res
      .status(404)
      .json({ error: "Escalation request not found or already resolved." });
  }

  if (decision === "REJECT") {
    await db
      .collection("escalation_requests")
      .updateOne(
        { _id: esc._id },
        {
          $set: {
            status: "REJECTED",
            resolved_by: "finance_lead",
            lead_note: lead_note || "Rejected by finance_lead",
            resolved_at: new Date(),
          },
        }
      );

    const policy_verdict = `Rejected by finance_lead: ${
      lead_note || "Request denied by lead."
    }`;
    await recordAuditEntry({
      trace_id: esc.trace_id,
      agent_id: esc.agent_id,
      authorized_by: "finance_lead",
      escalated_from: esc.requested_by,
      action: esc.action,
      amount: esc.amount,
      target_account: esc.target_account,
      customer_name: esc.customer_name,
      reason: esc.reason,
      agent_reasoning: esc.agent_reasoning,
      policy_cap_at_execution: null,
      policy_verdict,
      status: "BLOCKED_BY_DB_POLICY",
      blocked_at: new Date(),
    });

    return res.json({
      resolved: true,
      decision: "REJECTED",
      message: `finance_lead rejected the ${esc.action} request for ${
        esc.customer_name || esc.target_account
      }.`,
    });
  }

  if (esc.request_type === "ADD_ACCOUNT" || esc.action === "ADD_ACCOUNT") {
    const existing = await db
      .collection("customer_accounts")
      .findOne({ account_id: esc.target_account });
    if (existing) {
      return res
        .status(409)
        .json({ error: `Account ${esc.target_account} already exists.` });
    }

    await db.collection("customer_accounts").insertOne({
      account_id: esc.target_account,
      customer: esc.customer_name,
      balance: Number(esc.amount),
      created_by: "finance_lead",
      requested_by: esc.requested_by,
      created_at: new Date(),
    });

    await db
      .collection("escalation_requests")
      .updateOne(
        { _id: esc._id },
        {
          $set: {
            status: "APPROVED",
            resolved_by: "finance_lead",
            lead_note: lead_note || "Approved by finance_lead",
            resolved_at: new Date(),
          },
        }
      );

    const summary = `Approved new account ${esc.target_account} (${esc.customer_name}) with initial balance $${esc.amount}.`;
    await recordAuditEntry({
      trace_id: esc.trace_id,
      agent_id: esc.agent_id,
      authorized_by: "finance_lead",
      escalated_from: esc.requested_by,
      action: "ADD_ACCOUNT",
      amount: Number(esc.amount),
      target_account: esc.target_account,
      customer_name: esc.customer_name,
      reason: lead_note
        ? `${esc.reason} (Lead note: ${lead_note})`
        : esc.reason,
      agent_reasoning: `${esc.agent_reasoning} (Approved by finance_lead)`,
      policy_cap_at_execution: null,
      policy_verdict: `Approved by finance_lead (account creation requested by ${esc.requested_by}).`,
      pre_state: { balance: 0 },
      post_state: { balance: Number(esc.amount) },
      status: "COMMITTED",
      executed_at: new Date(),
    });

    return res.json({
      resolved: true,
      decision: "APPROVED",
      message: summary,
    });
  }

  const outcome = await submitIntentToMongo({
    trace_id: esc.trace_id,
    agent_id: esc.agent_id,
    authorized_by: "finance_lead",
    escalated_from: esc.requested_by,
    action: esc.action,
    amount: esc.amount,
    target_account: esc.target_account,
    reason: lead_note ? `${esc.reason} (Lead note: ${lead_note})` : esc.reason,
    agent_reasoning: `${esc.agent_reasoning} (Reviewed & approved by finance_lead)`,
  });

  await db.collection("escalation_requests").updateOne(
    { _id: esc._id },
    {
      $set: {
        status: outcome.allowed ? "APPROVED" : "FAILED",
        resolved_by: "finance_lead",
        lead_note: lead_note || "Approved by finance_lead",
        resolved_at: new Date(),
      },
    }
  );

  res.status(outcome.allowed ? 200 : 403).json({
    resolved: true,
    decision: "APPROVED",
    mongodb_gate_result: outcome,
    message: outcome.summary,
  });
});

// Endpoint 3: Live Policy Cap Update — ONLY finance_lead with valid PIN can modify support_tier_1 limit
app.post("/api/policy/cap", async (req, res) => {
  const { max_amount, authorized_by, lead_pin } = req.body;

  if (authorized_by !== "finance_lead" || !isValidLeadPin(lead_pin)) {
    return res.status(403).json({
      updated: false,
      error: `Access denied: Valid "finance_lead" role and PIN are required to modify spending policies.`,
    });
  }

  const newCap = Number(max_amount);
  if (!Number.isFinite(newCap) || newCap <= 0) {
    return res
      .status(400)
      .json({ updated: false, error: "Cap must be a positive dollar amount." });
  }

  await applyPolicyValidator(newCap);
  supportTierCap = newCap;

  res.json({
    updated: true,
    max_amount: supportTierCap,
    message: `finance_lead updated support_tier_1 spending cap to $${supportTierCap}.`,
  });
});

// Endpoint 4: Emergency Kill-Switch & Compensating Rollback (requires rollback_reason)
app.post("/api/agent/rollback/:trace_id", async (req, res) => {
  const { trace_id } = req.params;
  const actor = (req.body?.authorized_by || "operator").trim();
  const rollbackReason = (req.body?.rollback_reason || "").trim();

  if (!rollbackReason) {
    return res
      .status(400)
      .json({
        error:
          "A rollback reason is required before halting and reversing a session.",
      });
  }

  await db
    .collection("agent_runs")
    .updateOne(
      { trace_id },
      {
        $set: {
          aborted: true,
          aborted_by: actor,
          rollback_reason: rollbackReason,
          aborted_at: new Date(),
        },
      },
      { upsert: true }
    );

  const committed = await db
    .collection("audit_ledger")
    .find({ trace_id, status: "COMMITTED" })
    .sort({ executed_at: -1, _id: -1 })
    .toArray();

  let reversedCount = 0;
  for (const entry of committed) {
    if (entry.inverse_operation) {
      await db
        .collection("customer_accounts")
        .updateOne(entry.inverse_operation.filter, {
          $inc: { balance: entry.inverse_operation.delta },
        });
    } else if (entry.action === "ADD_ACCOUNT" && entry.target_account) {
      await db
        .collection("customer_accounts")
        .deleteOne({ account_id: entry.target_account });
    } else {
      continue;
    }

    const verdictMsg =
      entry.action === "ADD_ACCOUNT"
        ? `Emergency rollback: removed created account ${entry.target_account}.`
        : `Emergency rollback: reversed ${entry.action} of $${entry.amount} on ${entry.target_account}.`;

    await db.collection("audit_ledger").updateOne(
      { _id: entry._id },
      {
        $set: {
          status: "ROLLED_BACK",
          policy_verdict: verdictMsg,
          rolled_back_by: actor,
          rollback_reason: rollbackReason,
          rolled_back_at: new Date(),
        },
      }
    );

    if (entry.intent_id && ObjectId.isValid(entry.intent_id)) {
      await db
        .collection("action_intents")
        .updateOne(
          { _id: new ObjectId(entry.intent_id) },
          { $set: { status: "ROLLED_BACK" } }
        );
    }

    await refreshAuditEmbedding(entry._id);
    reversedCount++;
  }

  res.json({
    aborted: true,
    rolled_back_by: actor,
    rollback_reason: rollbackReason,
    rolled_back_count: reversedCount,
    message: `Session ${trace_id} halted by ${actor} and ${reversedCount} transaction(s) reversed. Reason: ${rollbackReason}`,
  });
});

// Endpoint 4B: Selective Rollback for One or Multiple Chosen Audit Entries (requires rollback_reason)
app.post("/api/audit/rollback-selected", async (req, res) => {
  try {
    const { entry_ids, authorized_by, rollback_reason } = req.body;
    const cleanReason = (rollback_reason || "").trim();

    if (!cleanReason) {
      return res
        .status(400)
        .json({
          error:
            "A rollback reason is required before reversing selected transactions.",
        });
    }
    if (!Array.isArray(entry_ids) || entry_ids.length === 0) {
      return res
        .status(400)
        .json({
          error: "Select at least one COMMITTED transaction to roll back.",
        });
    }

    const validObjectIds = entry_ids
      .filter((id) => ObjectId.isValid(id))
      .map((id) => new ObjectId(id));

    if (validObjectIds.length === 0) {
      return res
        .status(400)
        .json({ error: "No valid audit entry IDs provided." });
    }

    const targets = await db
      .collection("audit_ledger")
      .find({ _id: { $in: validObjectIds }, status: "COMMITTED" })
      .sort({ executed_at: -1, _id: -1 })
      .toArray();

    if (targets.length === 0) {
      return res
        .status(404)
        .json({
          error:
            "Selected entries are already rolled back or not in COMMITTED state.",
        });
    }

    const actor = (authorized_by || "operator").trim();
    let reversedCount = 0;

    for (const entry of targets) {
      if (entry.inverse_operation) {
        await db
          .collection("customer_accounts")
          .updateOne(entry.inverse_operation.filter, {
            $inc: { balance: entry.inverse_operation.delta },
          });
      } else if (entry.action === "ADD_ACCOUNT" && entry.target_account) {
        await db
          .collection("customer_accounts")
          .deleteOne({ account_id: entry.target_account });
      } else {
        continue;
      }

      const verdictMsg =
        entry.action === "ADD_ACCOUNT"
          ? `Selective rollback: removed created account ${entry.target_account}.`
          : `Selective rollback: reversed ${entry.action} of $${entry.amount} on ${entry.target_account}.`;

      await db.collection("audit_ledger").updateOne(
        { _id: entry._id },
        {
          $set: {
            status: "ROLLED_BACK",
            policy_verdict: verdictMsg,
            rolled_back_by: actor,
            rollback_reason: cleanReason,
            rolled_back_at: new Date(),
          },
        }
      );

      if (entry.intent_id && ObjectId.isValid(entry.intent_id)) {
        await db
          .collection("action_intents")
          .updateOne(
            { _id: new ObjectId(entry.intent_id) },
            { $set: { status: "ROLLED_BACK" } }
          );
      }

      await refreshAuditEmbedding(entry._id);
      reversedCount++;
    }

    return res.json({
      rolled_back_by: actor,
      rollback_reason: cleanReason,
      rolled_back_count: reversedCount,
      message: `${actor} rolled back ${reversedCount} selected transaction(s). Reason: ${cleanReason}`,
    });
  } catch (err) {
    console.error("❌ /api/audit/rollback-selected error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Endpoint 5: ElevenLabs Voice Security Alert & Audit Narrator
app.post("/api/voice/alert", async (req, res) => {
  const { text } = req.body;
  const elevenKey = process.env.ELEVENLABS_API_KEY;

  if (!elevenKey) {
    return res
      .status(400)
      .json({ error: "Missing ELEVENLABS_API_KEY in .env" });
  }

  try {
    const voiceId = "JBFqnCBsd6RMkjVDRZzb";
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": elevenKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          text: text.slice(0, 400),
          model_id: "eleven_flash_v2_5",
          voice_settings: { stability: 0.55, similarity_boost: 0.8 },
        }),
      }
    );

    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      return res
        .status(502)
        .json({ error: "ElevenLabs API error", details: errText });
    }

    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
    res.set("Content-Type", "audio/mpeg");
    res.send(audioBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: Parse numeric range, status, action, account ID, and customer name filters
function parseAuditQueryFilters(queryText, accounts = []) {
  const q = queryText.toLowerCase();
  const filter = {};
  let hasExactRule = false;

  const betweenMatch = q.match(
    /(?:between\s+)?\$?(\d+(?:\.\d+)?)\s*(?:and|to|-)\s*\$?(\d+(?:\.\d+)?)/
  );
  if (betweenMatch) {
    const low = Number(betweenMatch[1]);
    const high = Number(betweenMatch[2]);
    filter.amount = { $gte: Math.min(low, high), $lte: Math.max(low, high) };
    hasExactRule = true;
  } else {
    const gtMatch = q.match(
      /(?:greater than|more than|above|over|exceeding|>)\s*\$?(\d+(?:\.\d+)?)/
    );
    if (gtMatch) {
      filter.amount = { ...(filter.amount || {}), $gt: Number(gtMatch[1]) };
      hasExactRule = true;
    }
    const gteMatch = q.match(/(?:at least|minimum|>=)\s*\$?(\d+(?:\.\d+)?)/);
    if (gteMatch) {
      filter.amount = { ...(filter.amount || {}), $gte: Number(gteMatch[1]) };
      hasExactRule = true;
    }
    const ltMatch = q.match(/(?:less than|under|below|<)\s*\$?(\d+(?:\.\d+)?)/);
    if (ltMatch) {
      filter.amount = { ...(filter.amount || {}), $lt: Number(ltMatch[1]) };
      hasExactRule = true;
    }
    const lteMatch = q.match(/(?:at most|up to|<=)\s*\$?(\d+(?:\.\d+)?)/);
    if (lteMatch) {
      filter.amount = { ...(filter.amount || {}), $lte: Number(lteMatch[1]) };
      hasExactRule = true;
    }
  }

  if (
    /\b(rolled[\s-]?back|rollbacked|rollback|reversed|reversals?)\b/.test(q)
  ) {
    filter.status = "ROLLED_BACK";
    hasExactRule = true;
  } else if (/\bblocked\b/.test(q)) {
    filter.status = "BLOCKED_BY_DB_POLICY";
    hasExactRule = true;
  } else if (/\b(committed|approved|executed)\b/.test(q)) {
    filter.status = "COMMITTED";
    hasExactRule = true;
  } else if (/\b(escalated|pending)\b/.test(q)) {
    filter.status = "ESCALATED_PENDING";
    hasExactRule = true;
  }

  if (/\badd[\s_-]?account|onboard\b/.test(q)) {
    filter.action = "ADD_ACCOUNT";
    hasExactRule = true;
  } else if (/\b(charge|charged|deduct|deducted|deduction)\b/.test(q)) {
    filter.action = "CHARGE_CUSTOMER";
    hasExactRule = true;
  }

  const acctMatch = queryText.match(/ACCT-\d+/i);
  if (acctMatch) {
    filter.target_account = acctMatch[0].toUpperCase();
    hasExactRule = true;
  } else {
    const matchedAcct = accounts.find((a) => {
      const parts = a.customer.toLowerCase().split(/\s+/);
      return (
        q.includes(a.customer.toLowerCase()) ||
        parts.some(
          (p) => p.length >= 3 && new RegExp(`\\b${p}\\b`, "i").test(q)
        )
      );
    });
    if (matchedAcct) {
      filter.target_account = matchedAcct.account_id;
      hasExactRule = true;
    }
  }

  return { filter, hasExactRule };
}

// Endpoint 6: Hybrid Search (Voyage AI Semantic Ranking + MongoDB Numeric/Metadata Filtering)
app.post("/api/audit/search", async (req, res) => {
  try {
    const cleanQuery = (req.body?.query || "").trim();
    if (!cleanQuery) {
      return res
        .status(400)
        .json({ error: "Enter a natural-language audit search query." });
    }

    const accounts = await db
      .collection("customer_accounts")
      .find({})
      .toArray();
    const { filter, hasExactRule } = parseAuditQueryFilters(
      cleanQuery,
      accounts
    );
    const hasFilters = Object.keys(filter).length > 0;

    const missingDocs = await db
      .collection("audit_ledger")
      .find({ audit_embedding: { $exists: false } })
      .limit(20)
      .toArray();

    if (missingDocs.length > 0) {
      const batchTexts = missingDocs.map(
        (doc) =>
          `${doc.status} | ${doc.action} $${doc.amount} on ${
            doc.target_account
          } (${doc.customer_name || ""}) | Role: ${
            doc.authorized_by
          } | Reason: ${doc.reason} | Reasoning: ${
            doc.agent_reasoning || ""
          } | Verdict: ${doc.policy_verdict || ""}`
      );
      const { vectors } = await embedVoyageBatch(batchTexts, "document");
      for (let i = 0; i < missingDocs.length; i++) {
        if (vectors[i]) {
          await db
            .collection("audit_ledger")
            .updateOne(
              { _id: missingDocs[i]._id },
              { $set: { audit_embedding: vectors[i] } }
            );
        }
      }
    }

    let queryVector = queryVectorCache.get(cleanQuery.toLowerCase());
    let voyageRateLimited = false;
    if (!queryVector) {
      const { vectors } = await embedVoyageBatch([cleanQuery], "query");
      if (vectors[0]) {
        queryVector = vectors[0];
        queryVectorCache.set(cleanQuery.toLowerCase(), queryVector);
      } else {
        voyageRateLimited = true;
      }
    }

    if (voyageRateLimited || !queryVector) {
      const fallbackDocs = await db
        .collection("audit_ledger")
        .find(filter, { projection: { audit_embedding: 0 } })
        .sort({ _id: -1 })
        .limit(15)
        .toArray();

      return res.json({
        engine: `MongoDB Hybrid Filter${
          hasExactRule ? " + Exact Status/Range Rule" : ""
        }`,
        results: fallbackDocs,
      });
    }

    try {
      const vectorStage = {
        index: "audit_vector_index",
        path: "audit_embedding",
        queryVector,
        numCandidates: 50,
        limit: 10,
        ...(hasFilters ? { filter } : {}),
      };

      const results = await db
        .collection("audit_ledger")
        .aggregate([
          { $vectorSearch: vectorStage },
          {
            $project: {
              audit_embedding: 0,
              score: { $meta: "vectorSearchScore" },
            },
          },
        ])
        .toArray();

      return res.json({
        engine: `MongoDB Atlas $vectorSearch + Voyage AI (voyage-3)${
          hasExactRule ? " + Exact Filter" : ""
        }`,
        results,
      });
    } catch (vectorErr) {
      const docs = await db.collection("audit_ledger").find(filter).toArray();
      const cosine = (a, b) =>
        a.reduce((sum, val, i) => sum + val * (b[i] || 0), 0);
      const ranked = docs
        .map((d) => {
          const score = Array.isArray(d.audit_embedding)
            ? Number(cosine(queryVector, d.audit_embedding).toFixed(4))
            : null;
          const { audit_embedding, ...rest } = d;
          return score !== null ? { ...rest, score } : rest;
        })
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        .slice(0, 10);

      return res.json({
        engine: `Voyage AI (voyage-3) Hybrid Search${
          hasExactRule ? " + Exact Filter" : ""
        }`,
        results: ranked,
      });
    }
  } catch (err) {
    console.error("❌ /api/audit/search error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/state", async (req, res) => {
  const accounts = await db.collection("customer_accounts").find({}).toArray();
  const ledger = await db
    .collection("audit_ledger")
    .find({}, { projection: { audit_embedding: 0 } })
    .sort({ _id: -1 })
    .limit(15)
    .toArray();
  const pendingEscalations = await db
    .collection("escalation_requests")
    .find({ status: "PENDING" })
    .sort({ _id: -1 })
    .toArray();
  res.json({
    accounts,
    ledger,
    currentMaxCap: supportTierCap,
    pendingEscalations,
  });
});

startWorker().then(() => {
  app.listen(3000, () =>
    console.log("🚀 Gatekeeper running at http://localhost:3000")
  );
});
