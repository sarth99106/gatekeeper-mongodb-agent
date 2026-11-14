# 🛡️ Gatekeeper — Policy-Gated Financial Operations Agent

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MongoDB Atlas](https://img.shields.io/badge/MongoDB%20Atlas-%24jsonSchema%20%7C%20Change%20Streams%20%7C%20%24vectorSearch-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/atlas)
[![LangChain](https://img.shields.io/badge/LangChain-Groq%20Structured%20Output-1C3C3C?logo=langchain&logoColor=white)](https://js.langchain.com/)
[![Voyage AI](https://img.shields.io/badge/Voyage%20AI-voyage--3%20Embeddings-2563EB)](https://www.voyageai.com/)
[![ElevenLabs](https://img.shields.io/badge/ElevenLabs-Voice%20Alerts%20%26%20Narration-000000)](https://elevenlabs.io/)

**Gatekeeper** is an auditable financial operations (FinOps) agent built with **MongoDB Atlas**, **LangChain (Groq)**, **Voyage AI**, and **ElevenLabs**. Rather than trusting an LLM to self-police financial mutations, Gatekeeper uses MongoDB Atlas as a storage-layer **identity, policy, and audit engine**—ensuring every action is tied to an IAM role, validated against strict `$jsonSchema` rules *before* execution, and recorded in an immutable audit ledger with full session and selective rollback support.

---

## 📋 Table of Contents
- [System Architecture](#-system-architecture)
- [Core Governance Pillars](#-core-governance-pillars)
- [MongoDB Atlas Data Model](#-mongodb-atlas-data-model)
- [Project Structure](#-project-structure)
- [Quick Start & Setup](#-quick-start--setup)
- [Interactive Demo Walkthrough](#-interactive-demo-walkthrough)
- [API Reference](#-api-reference)

---

## 🏗️ System Architecture

```text
┌───────────────────────────┐     ┌────────────────────────────────────────┐
│   Operator / Agent UI     │────▶│   Express API + LangChain (ChatGroq)   │
│   (IAM Role + Lead PIN)   │     │   Zod Schema Structured Extraction     │
└───────────────────────────┘     └───────────────────┬────────────────────┘
                                                      │
              ┌───────────────────────────────────────┼───────────────────────────────────────┐
              ▼                                       ▼                                       ▼
┌───────────────────────────┐           ┌───────────────────────────┐           ┌───────────────────────────┐
│ Pre-Execution HITL Gates  │           │   MongoDB Atlas Layer     │           │  ElevenLabs Voice Engine  │
│ • Deductions & Charges    │           │ • $jsonSchema Policy Gate │           │ • Security Breach Alerts  │
│ • Duplicate Discrepancies │           │ • Change Stream Worker    │           │ • Escalation Alerts       │
│ • Identity Verification   │           │ • $vectorSearch Index     │           │ • On-Demand Audit Audio   │
│ • PIN Lead Approval Inbox │           └─────────────┬─────────────┘           └───────────────────────────┘
└───────────────────────────┘                         │
                                                      ▼
                                        ┌───────────────────────────┐
                                        │   Voyage AI (voyage-3)    │
                                        │   1024-d Audit Embeddings │
                                        │   + Hybrid Filter Search  │
                                        └───────────────────────────┘
```

---

## 🔐 Core Governance Pillars

### 1. Pre-Execution Storage-Layer Policy Enforcement (`$jsonSchema`)
* **Database-Level Guardrails:** The `action_intents` collection enforces a strict MongoDB `$jsonSchema` validator (`validationLevel: "strict"`, `validationAction: "error"`). Even if application-layer checks are bypassed, MongoDB rejects unauthorized or over-cap writes before they commit or trigger Change Streams.
* **IAM Role Hierarchy:**
  * **`support_tier_1`:** Authorized to execute `ISSUE_REFUND` and `CHARGE_CUSTOMER` up to the active spending cap (default **$500**). Over-cap transactions are blocked at the database layer and can be escalated to the `finance_lead` queue.
  * **`finance_lead`:** Protected by a security PIN (`FINANCE_LEAD_PIN`). Unlocks unlimited spending authority, live spending cap updates (`collMod`), direct customer account creation, and escalation approval/rejection controls.
  * **`untrusted_bot`:** Blocked immediately by the MongoDB schema validator and logged as `BLOCKED_BY_DB_POLICY`.

### 2. Human-in-the-Loop (HITL) & Identity Guardrails
* **Customer Deductions (`CHARGE_CUSTOMER`):** Always pauses execution to require explicit operator confirmation and a written audit reason before deducting funds.
* **Duplicate-Charge Discrepancy Detection:** Flags anomalies when a ticket requests a refund amount that differs from the single billed unit price (e.g., requesting `$60` vs. a `$70` duplicate plan charge).
* **Identity & Account Verification:** Cross-checks customer names against `ACCT-XXX` IDs, halting on unrecognized names or name/ID mismatches.
* **Account Onboarding Governance (`ADD_ACCOUNT`):** Account creation requests from `support_tier_1` (via UI form or natural-language ticket) are routed to the `finance_lead` approval inbox; balance top-ups for existing customers automatically credit their existing account rather than creating duplicate account IDs.

### 3. Complete Audit Reconstruction (`Who`, `What`, `Why`)
* **Reactive Change Streams:** A MongoDB Change Stream watches validated `insert` events on `action_intents`, mutates `customer_accounts`, and records a complete audit trail in `audit_ledger`.
* **Full Attribution:** Every ledger entry captures:
  * **Authority:** `authorized_by`, `escalated_from`, `rolled_back_by`, `trace_id` (`RUN-XXXX`), and `policy_cap_at_execution`.
  * **State Delta:** `pre_state` $\rightarrow$ `post_state` balances and `inverse_operation` metadata.
  * **Reasoning & Verdicts:** Operator `reason`, LLM `agent_reasoning`, database `policy_verdict`, and `rollback_reason`.

### 4. Hybrid Semantic Audit Search (Voyage AI + MongoDB Atlas)
* Embeds every audit record using **Voyage AI (`voyage-3`, 1024 dimensions)** and pairs cosine similarity ranking with deterministic MongoDB filters for numeric ranges (`between 60 to 70`, `greater than 500`), statuses (`rollbacked`, `blocked`, `committed`, `escalated`), actions (`ADD_ACCOUNT`, `CHARGE_CUSTOMER`), and customer names/account IDs.

### 5. Mid-Run Kill-Switch & Selective Compensating Rollbacks
* **Emergency Session Kill-Switch:** Marks `aborted: true` in `agent_runs` to halt any in-flight Change Stream execution for the active `RUN-XXXX` trace and reverses all `COMMITTED` operations in reverse chronological order.
* **Single & Batch Selective Rollback:** Operators can select individual or multiple `COMMITTED` audit entries to reverse without halting the active session. Every rollback prompts for a mandatory audit reason, records `rolled_back_by` and `rollback_reason`, and updates the entry's Voyage AI embedding.

---

## 🗄️ MongoDB Atlas Data Model

Database: **`gatekeeper_db`**

| Collection | Purpose | Key Features |
| :--- | :--- | :--- |
| `customer_accounts` | Live customer profiles and balances (`ACCT-101`, `ACCT-202`, etc.) | Atomic `$set` / `$inc` updates & compensating reversals |
| `action_intents` | Policy-gated staging queue for validated financial actions | Strict `$jsonSchema` validator + Change Stream trigger |
| `audit_ledger` | Immutable governance log of all executed, blocked, escalated, and rolled-back actions | 1024-d `audit_embedding` vectors for `$vectorSearch` |
| `escalation_requests` | Approval inbox for over-cap transactions and `support_tier_1` new account requests | Resolved exclusively by PIN-authenticated `finance_lead` |
| `agent_runs` | Session trace registry (`RUN-XXXX`) | Tracks `aborted` status for mid-run kill-switch enforcement |

---

## 📁 Project Structure

```text
gatekeeper/
├── public/
│   └── index.html          # FinOps console, PIN modal, HITL cards, rollback controls & audit search UI
├── server.js               # Express API, LangChain/Groq agent, MongoDB $jsonSchema & Change Streams
├── setup_db.js             # Database initializer & clean seed script
├── package.json            # Project dependencies
├── .env.example            # Environment variable template
├── .gitignore              # Git ignore rules (.env, node_modules)
└── README.md               # Documentation
```

---

## 🚀 Quick Start & Setup

### 1. Prerequisites
* **Node.js** v18 or higher
* **MongoDB Atlas** cluster (M0 Free Tier or higher)
* API keys for **Groq**, **Voyage AI**, and **ElevenLabs** (plus **LangSmith** for LLM trace observability)

### 2. Clone & Install Dependencies
```bash
git clone https://github.com/[YOUR_USERNAME]/[YOUR_REPO_NAME].git
cd [YOUR_REPO_NAME]
npm install
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your credentials:

```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/gatekeeper_db?retryWrites=true&w=majority
GROQ_API_KEY=gsk_your_groq_api_key
VOYAGE_API_KEY=pa-your_voyage_api_key
ELEVENLABS_API_KEY=sk_your_elevenlabs_api_key
FINANCE_LEAD_PIN=1234

# Optional: LangSmith LLM Observability
LANGSMITH_TRACING=true
LANGCHAIN_TRACING_V2=true
LANGSMITH_API_KEY=lsv2_pt_your_langsmith_key
LANGSMITH_PROJECT=gatekeeper-mongodb-audit
```

### 4. Configure MongoDB Atlas Vector Search Index
In **MongoDB Atlas $\rightarrow$ Atlas Search & Vector Search**, create a Vector Search index named **`audit_vector_index`** on **`gatekeeper_db.audit_ledger`**:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "audit_embedding",
      "numDimensions": 1024,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "amount"
    },
    {
      "type": "filter",
      "path": "status"
    },
    {
      "type": "filter",
      "path": "target_account"
    }
  ]
}
```

### 5. Seed Database & Launch
```bash
node setup_db.js
node server.js
```
Open **`http://localhost:3000`** in your browser.

---

## 🎯 Interactive Demo Walkthrough

1. **Standard Policy-Compliant Execution (`support_tier_1`):**
   * Click **Valid Refund ($60)** and **Process Ticket with AI Agent**.
   * MongoDB validates the `$60` intent against the `$500` cap, updates `ACCT-101` via Change Streams, and logs `COMMITTED` in the audit ledger.
2. **Pre-Execution HITL Guardrails:**
   * Test **Discrepancy ($70 vs $60)**, **Wrong Name ("AB")**, or **Deduct / Charge ($100)** to see the agent pause for operator verification and mandatory audit reasoning before touching balances.
3. **Database Policy Gate & PIN-Protected Lead Escalation:**
   * Click **Over-Cap Request ($800)** as `support_tier_1` $\rightarrow$ blocked by MongoDB `$jsonSchema` with an ElevenLabs voice alert.
   * Click **Send Escalation Request to finance_lead**, switch **Session IAM Role** to **`finance_lead`** (PIN: `1234`), and approve the request from the lead inbox.
4. **Hybrid Audit Search & Selective Rollback:**
   * Query the ledger in natural language (e.g., `rollbacked transactions`, `amount refund between 60 to 70`, or `Bob`).
   * Click **`↩ Rollback`** on any `COMMITTED` row (or select multiple checkboxes and click **`↩ Rollback Selected`**), enter a rollback reason, and click **`🔊 Narrate`** to hear the spoken audit summary.

---

## 📡 API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/auth/verify-lead` | Verifies `FINANCE_LEAD_PIN` before unlocking `finance_lead` controls. |
| `POST` | `/api/accounts` | Creates a new customer account (queued if `support_tier_1`, immediate if `finance_lead`). |
| `POST` | `/api/agent/ticket` | Extracts structured intent via LangChain + Groq and enforces HITL & MongoDB `$jsonSchema` gates. |
| `POST` | `/api/agent/confirm` | Executes operator-confirmed resolutions for discrepancies, identity mismatches, and deductions. |
| `POST` | `/api/escalations` | Queues over-cap requests for `finance_lead` approval. |
| `POST` | `/api/escalations/:id/resolve` | Allows PIN-authenticated `finance_lead` to approve or reject queued requests. |
| `POST` | `/api/policy/cap` | Dynamically updates the MongoDB `$jsonSchema` spending cap for `support_tier_1`. |
| `POST` | `/api/agent/rollback/:trace_id` | Emergency kill-switch that aborts a session and reverses all committed actions in that trace. |
| `POST` | `/api/audit/rollback-selected` | Selectively reverses one or more chosen `COMMITTED` ledger entries with a required audit reason. |
| `POST` | `/api/audit/search` | Hybrid Voyage AI semantic + MongoDB numeric/metadata search across `audit_ledger`. |
| `POST` | `/api/voice/alert` | Generates ElevenLabs TTS audio for security alerts and audit narration. |
| `GET` | `/api/state` | Retrieves live customer balances, recent audit entries, active spending cap, and pending escalations. |
