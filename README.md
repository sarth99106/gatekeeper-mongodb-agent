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
