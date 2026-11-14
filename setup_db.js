require("dotenv").config();
const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("❌ Missing MONGODB_URI in .env");
  process.exit(1);
}

const intentValidator = {
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
        enum: ["support_tier_1", "finance_lead", "compliance_admin"],
        description: "Identity role must be an approved IAM role",
      },
      action: {
        bsonType: "string",
        enum: ["ISSUE_REFUND", "FREEZE_ACCOUNT"],
        description: "Only approved tool actions are permitted",
      },
      amount: {
        bsonType: ["int", "double"],
        minimum: 0,
        maximum: 500,
        description:
          "Hard policy cap: autonomous agents cannot exceed $500 per action",
      },
      target_account: { bsonType: "string" },
      reason: { bsonType: "string" },
      status: {
        bsonType: "string",
        enum: ["VALIDATED_INTENT", "EXECUTED", "ROLLED_BACK"],
      },
      created_at: { bsonType: "date" },
    },
  },
};

async function setup() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db("gatekeeper_db");

    // 1. Create or update action_intents with strict $jsonSchema enforcement
    const existing = await db
      .listCollections({ name: "action_intents" })
      .toArray();
    if (existing.length === 0) {
      await db.createCollection("action_intents", {
        validator: intentValidator,
        validationLevel: "strict",
        validationAction: "error",
      });
      console.log(
        "✅ Created action_intents with strict $jsonSchema policy gate"
      );
    } else {
      await db.command({
        collMod: "action_intents",
        validator: intentValidator,
        validationLevel: "strict",
        validationAction: "error",
      });
      console.log("✅ Updated action_intents $jsonSchema policy gate");
    }

    // 2. Seed mock customer accounts for live mutation + rollback demo
    const accounts = db.collection("customer_accounts");
    await accounts.deleteMany({});
    await accounts.insertMany([
      {
        account_id: "ACCT-101",
        customer: "Alice Chen",
        balance: 1000,
        status: "ACTIVE",
      },
      {
        account_id: "ACCT-202",
        customer: "Bob Patel",
        balance: 2500,
        status: "ACTIVE",
      },
    ]);

    // Clear old audit/run logs for a clean start
    await db.collection("audit_ledger").deleteMany({});
    await db.collection("agent_runs").deleteMany({});

    console.log(
      "✅ Seeded customer_accounts (ACCT-101: $1000, ACCT-202: $2500)"
    );
    console.log("🎉 Atlas Sandbox setup complete!");
  } finally {
    await client.close();
  }
}

setup().catch(console.error);
