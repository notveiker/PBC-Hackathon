# Nile Commerce Gateway v2 — Full Technical Write-Up

## What This Is

Nile Commerce Gateway is a complete agentic commerce platform built on TRON. It enables AI agents to autonomously discover paid API services, pay for them using TRX or USDT on-chain, receive cryptographically signed settlement receipts, and consume the purchased data — all without human intervention.

This is **not** a chatbot that sends tokens. It is a full commerce stack:

- **HTTP 402 Payment Protocol** — APIs return "Payment Required" with structured payment instructions, following the x402 standard
- **On-Chain Settlement** — Payments happen on TRON's Nile testnet with real blockchain verification
- **JWT Settlement Receipts** — Every payment produces a signed ES256 receipt that proves the transaction happened
- **Smart Contract Escrow** — Buyers can lock funds in escrow and dispute bad service delivery
- **Agent Identity Registry** — Agents self-register on-chain and build reputation through completed transactions
- **OPSEC Safety Tooling** — Agents simulate transactions before signing, analyze contracts for risk, and track spending against budgets
- **Multi-Sig Security** — TRON's Account Permission Management constrains agent wallets to only payment operations

The system has a 7-tab web dashboard, a 24-endpoint REST API, two deployed Solidity smart contracts on Nile, an LLM-powered autonomous agent (Claude/GPT), and a complete CLI demo that exercises every feature end-to-end with real on-chain transactions.

---

## How It Works — The Full Flow

### 1. Service Discovery

An AI agent (or human) hits `GET /v1/registry` and receives a complete catalog of available paid services:

```json
{
  "gateway": "tron-commerce-gateway",
  "x402Compatible": true,
  "services": [
    {
      "path": "/v1/agent/premium-quote",
      "productName": "AI Premium Quote API",
      "price": { "asset": "TRX", "amount": "1000000", "humanReadable": "1 TRX" },
      "merchant": { "id": "market-alpha", "name": "Market Alpha Research", "trust": { "trustScore": 92 } },
      "manifestJwt": "eyJ..." // signed proof this service entry is authentic
    }
  ]
}
```

Each service and merchant has a signed JWT manifest — the agent can verify these against the gateway's public key at `/.well-known/jwks.json` to ensure the registry hasn't been tampered with.

### 2. The x402 Payment Flow

When the agent requests a paid resource, the server returns HTTP 402:

```
GET /v1/agent/premium-quote → 402 Payment Required

{
  "error": "payment_required",
  "paymentRequired": {
    "x402Version": 1,
    "scheme": "tron-settlement",
    "network": "tron-nile",
    "amount": "1000000",        // 1 TRX in SUN
    "amountAsset": "TRX",
    "recipient": "TNpQx7...",   // merchant's TRON address
    "nonce": "6ff3a573...",     // unique payment session ID
    "productName": "AI Premium Quote API"
  }
}
```

The agent then:
1. Sends 1 TRX to the merchant address on TRON Nile
2. Gets back a transaction hash (txId)
3. Retries the same request with payment proof headers:

```
GET /v1/agent/premium-quote
X-Payment-Nonce: 6ff3a573...
X-Payment-Tx-Id: 65ca197b...
```

### 3. On-Chain Verification

The server does NOT trust the agent's claim. It independently verifies the transaction on TRON:

1. Fetches the transaction from the TRON node via TronWeb
2. Confirms `contractRet === "SUCCESS"`
3. Checks the recipient matches the merchant address exactly
4. Checks the amount is >= the required price (BigInt comparison)
5. Checks the transaction ID hasn't been used before (replay prevention via SQLite UNIQUE constraint)
6. Validates the payment nonce matches the pending session

Only after all checks pass does the server:
- Record the settlement in SQLite
- Issue an ES256 JWT receipt
- Deliver the purchased data

### 4. Settlement Receipt

The response includes a signed JWT receipt and the live data:

```json
{
  "ok": true,
  "accessToken": "eyJhbGciOiJFUzI1NiI...",
  "data": {
    "quote": {
      "symbol": "TRXUSDT",
      "bid": 0.234684,
      "ask": 0.234784,
      "spread": 0.0001,
      "source": "binance"
    },
    "settlementTx": "65ca197b..."
  },
  "verification": {
    "chain": "tron-nile",
    "settlementTx": "65ca197b...",
    "payer": "TXSCB6eq...",
    "blockNumber": 66068349
  }
}
```

The JWT receipt can be reused via `Authorization: Bearer <token>` for 1 hour without paying again — this is session re-use.

### 5. Escrow & Dispute Resolution (Smart Contract)

For high-value purchases, instead of paying directly, an agent can lock funds in the **EscrowPayment** smart contract:

```
Agent → createEscrow(serviceId, merchant) + TRX deposit
         ↓
    [CREATED] — funds locked for 20 blocks (~1 minute)
         ↓
    If satisfied → merchant calls claimEscrow() → funds released
    If unhappy  → agent calls initiateDispute() within lock period
         ↓
    [DISPUTED] — arbitrator (gateway) resolves
         ↓
    resolveDispute(buyerPct=70) → 70% back to buyer, 30% to merchant
```

Every state transition emits on-chain events that are verifiable on Nile Tronscan. The gateway records all escrow activity in SQLite for the dashboard.

### 6. Agent Identity & Reputation (Smart Contract)

The **AgentRegistry** smart contract lets agents self-register with a metadata URI:

```
Agent → registerAgent("https://agent.nile/profile.json")
         ↓
    On-chain: { metadataURI, reputation: 0, registered: true }
         ↓
    After successful transactions, gateway calls:
    updateReputation(agent, +10)
         ↓
    Agent earns badges: bronze (0+), silver (20+), gold (50+)
```

This goes beyond ERC-8004 (which is static metadata) by adding mutable, gateway-attested reputation that changes over time.

### 7. OPSEC Safety Tooling

Before signing any transaction, agents can run safety checks:

**Transaction Simulator** (`POST /v1/opsec/simulate`):
- Is the recipient a known merchant in the registry?
- Is the amount within configured spending caps?
- Does the address match known scam patterns?
- Is the recipient account active on Nile?
- If USDT, is the token contract the known Nile USDT?

**Contract Analyzer** (`POST /v1/opsec/analyze-contract`):
- Is the address a smart contract?
- Does it have bytecode?
- Is it a known token (USDT, etc.)?
- Risk level assessment

**Spending Report** (`GET /v1/opsec/spending-report`):
- Total TRX and USDT spent in the period
- Per-merchant breakdown
- Budget usage percentage against configured caps

### 8. Multi-Sig Security

The `tron-permission-setup.ts` script configures TRON's Account Permission Management:

- **OWNER key** stays cold (never used in agent code)
- **AGENT key** gets a constrained ACTIVE permission:
  - Can only: TransferContract (TRX) + TriggerSmartContract (USDT)
  - Cannot: UpdateAccountPermission, FreezeBalance, VoteWitness, etc.

If the agent is compromised, the attacker can only send TRX up to the wallet balance — they cannot change permissions, stake, vote, or do anything privileged.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React + Vite)                    │
│  7 tabs: Marketplace | Buy | Sell | Trust | Escrow | Agents | OPSEC │
│                    http://localhost:5173                      │
└──────────────────────┬──────────────────────────────────────┘
                       │ Vite proxy (/v1, /.well-known, /health)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                 Backend (Fastify + TypeScript)                │
│  24 REST endpoints | Zod validation | Rate limiting          │
│  ES256 JWT receipts | SQLite persistence                     │
│                    http://localhost:3001                      │
├─────────────────────────────────────────────────────────────┤
│  commerceRoutes    │ x402 payment flow, registry, merchant   │
│  escrowRoutes      │ escrow CRUD, dispute, resolve           │
│  agentRegistryRoutes│ register, reputation, profiles         │
│  opsecRoutes       │ simulate, analyze, spending report      │
└──────────┬──────────────────────────────┬───────────────────┘
           │                              │
           ▼                              ▼
┌──────────────────┐          ┌───────────────────────┐
│   TRON Nile      │          │   SQLite (commerce.db) │
│   (TronWeb SDK)  │          │   settlements          │
│                  │          │   pending_payments     │
│  Verify txs      │          │   risk_events          │
│  Deploy contracts│          │   escrows              │
│  Read state      │          │   agent_profiles       │
└──────────────────┘          └───────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│   Smart Contracts (Solidity on TRON) │
│                                      │
│  EscrowPayment.sol                   │
│    createEscrow, claimEscrow,        │
│    initiateDispute, resolveDispute   │
│                                      │
│  AgentRegistry.sol                   │
│    registerAgent, updateReputation,  │
│    getAgent, recordTransaction       │
└──────────────────────────────────────┘
```

---

## What's Deployed On-Chain (Live on Nile Testnet)

| Artifact | Address / Tx Hash |
|---|---|
| **EscrowPayment Contract** | `TB7LK71S5AkYUMRdPvohWmzeMX25JhvWqs` |
| **AgentRegistry Contract** | `TNNBCnsMvPZ9ZQvNRuKu1mRxx5dg9buGvX` |
| **Merchant Wallet** | `TNpQx7Ujg7pdTm18HQc8Uzqz9go8JdnpQt` |
| **Agent Wallet** | `TXSCB6eqP27nUVFUjmfXKboqEJQS9YBKjJ` |
| **x402 Payment Tx** | `65ca197bf5d315bca3e736b865c79be2096a83514ab7caa3a2508172c0d9cf7f` |
| **Escrow Creation Tx** | `7e36f9e4eb600e20a9759446b548bc4a6a0b40072f51a034864b48ee53b5b559` |
| **Agent Registration Tx** | `32a553411238d4959a737cb98b394a8b85a968194c2148ca85c33e2721340d73` |
| **Reputation Update Tx** | `386d9a05b87b854aa9501dbf4b44a895979ae7f74e31e234113ced6036d03cde` |

All verifiable at `https://nile.tronscan.org/#/transaction/<hash>`

---

## How to Set Up and Run

### Prerequisites

- **Node.js v20+**
- **TronLink browser extension** on Nile Testnet (for the web UI payment flow)
- **Two funded Nile testnet wallets** (get TRX from https://nileex.io/join/getJoinPage)

### Step 1: Clone and Install

```bash
git clone <your-repo-url>
cd tron-nile-commerce-gateway
npm install
```

### Step 2: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# Required — your merchant wallet on Nile (receives payments)
MERCHANT_TRON_ADDRESS=T...your-merchant-address...

# Required for agent scripts — payer wallet private key (64 hex chars)
NILE_PAYER_PRIVATE_KEY=...your-payer-private-key...

# Required for smart contract deployment and admin operations
GATEWAY_PRIVATE_KEY=...your-merchant-private-key...
DEPLOYER_PRIVATE_KEY=...same-as-gateway-key...

# Payment asset (TRX is simplest for testnet — no energy needed)
PAYMENT_ASSET=TRX
```

### Step 3: Start Development Server

```bash
npm run dev
```

This starts:
- **Backend** at http://localhost:3001 (Fastify + TypeScript)
- **Frontend** at http://localhost:5173 (Vite + React)

### Step 4: Deploy Smart Contracts (Optional)

```bash
# Compile Solidity → ABI + bytecode
npm run contracts:compile

# Deploy to Nile testnet (uses DEPLOYER_PRIVATE_KEY)
npm run contracts:deploy

# Verify contracts respond correctly
npm run contracts:verify
```

After deploying, add the contract addresses to `.env`:
```bash
ESCROW_CONTRACT_ADDRESS=T...
AGENT_REGISTRY_CONTRACT_ADDRESS=T...
```

### Step 5: Run the Full Live Demo

```bash
# 9-step end-to-end verification with real on-chain transactions
npm run go-live
```

This script:
1. Checks wallet balances on Nile
2. Deploys contracts (if not already deployed)
3. Registers the agent on the AgentRegistry contract
4. Runs OPSEC safety simulation
5. Executes a real x402 payment (sends TRX on Nile)
6. Verifies the payment and receives data + JWT receipt
7. Tests JWT session re-use
8. Creates an on-chain escrow
9. Updates agent reputation on-chain
10. Prints a spending report

Every step produces verifiable transaction hashes on Nile Tronscan.

### Step 6: Explore the Dashboard

Open http://localhost:5173 in your browser:

| Tab | What It Shows |
|---|---|
| **Marketplace** | Product overview, service registry, how-it-works |
| **Buy** | Select a service, see the 402 response, pay via TronLink, get data |
| **Sell** | Merchant dashboard — settlement ledger, revenue stats |
| **Trust** | Security audit log, TRON permission model, OPSEC rules |
| **Escrow** | Create/track/dispute escrows, resolve with arbitrator slider |
| **Agents** | Register agent identity, view profiles, reputation badges |
| **OPSEC** | Transaction simulator, contract analyzer, spending dashboard |

### Other Useful Commands

```bash
npm run test              # Run all 15 tests
npm run build             # Production build (server + web)
npm run check             # Build + test combined
npm run contracts:compile # Compile Solidity contracts
npm run agent:enhanced    # 7-step CLI agent demo
npm run agent:ai          # LLM-powered agent (needs ANTHROPIC_API_KEY or OPENAI_API_KEY)
npm run permission-setup  # Configure TRON multi-sig permissions
```

---

## Bounty Coverage (7 of 8 Directions)

| Direction | What We Built |
|---|---|
| **x402-style payments on TRON** | Full HTTP 402 → pay on Nile → verify on-chain → JWT receipt flow. 4 priced services with live Binance market data. |
| **Agentic commerce standards** | Service registry with signed JWT manifests, dynamic merchant/service onboarding, OpenAPI spec, typed API client. |
| **Micro-transaction enablement** | Pay-per-call with metered receipts, session re-use via JWT Bearer, spending reports with budget tracking. |
| **Discovery + trust beyond ERC-8004** | AgentRegistry smart contract with self-registration, mutable gateway-attested reputation, and badge system (bronze/silver/gold). |
| **Security-centric agent execution** | TRON Account Permission Management constraining agent keys to TransferContract + TriggerSmartContract only. |
| **Agentic chargeback / dispute** | EscrowPayment smart contract with time-locked release, buyer-initiated disputes, and arbitrator resolution with percentage split. |
| **OPSEC dev tooling** | Transaction simulator (5 safety checks), contract risk analyzer, spending report with per-merchant breakdown and budget bars. |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Fastify 5, TypeScript, better-sqlite3 (WAL mode) |
| Frontend | React 19, Vite 6, TypeScript |
| Blockchain | TronWeb 6, TRON Nile Testnet |
| Smart Contracts | Solidity 0.8.20, compiled with solc |
| Auth/Receipts | jose (ES256 JWT), JWKS endpoint |
| Validation | Zod schemas on all inputs |
| AI Agent | Anthropic SDK (Claude) / OpenAI SDK (GPT) |
| Testing | Node.js built-in test runner, Fastify inject |

---

## Security Model

1. **Transaction replay prevention** — SQLite UNIQUE constraint on tx_id
2. **On-chain verification** — Server re-fetches every tx from TRON node, checks recipient + amount + status
3. **Nonce binding** — 128-bit random nonces with 30-minute TTL
4. **JWT receipts** — ES256 asymmetric signing, public key at /.well-known/jwks.json
5. **Rate limiting** — 240 req/min global via Fastify plugin
6. **Input validation** — Zod schemas on every POST body
7. **OPSEC simulation** — Pre-flight safety checks before any payment
8. **Spending caps** — Configurable per-agent limits on USDT and TRX
9. **Admin auth** — API key protection on privileged endpoints (reputation, dispute resolution)
10. **Multi-sig** — TRON Account Permission Management for hot wallet constraint
11. **Escrow** — Time-locked on-chain escrow with dispute mechanism

---

## File Structure

```
tron-nile-commerce-gateway/
├── contracts/                  # Solidity smart contracts
│   ├── EscrowPayment.sol       # On-chain escrow with dispute resolution
│   ├── AgentRegistry.sol       # Agent identity + reputation
│   ├── compile.ts              # Compile with solc
│   ├── deploy.ts               # Deploy to Nile via TronWeb
│   └── verify.ts               # Verify deployed contracts
├── server/src/                 # Backend (Fastify + TypeScript)
│   ├── index.ts                # Server entry, route registration
│   ├── commerceRoutes.ts       # x402 payment flow, registry, merchant dashboard
│   ├── escrowRoutes.ts         # Escrow CRUD, dispute, resolve
│   ├── agentRegistryRoutes.ts  # Agent registration, reputation, profiles
│   ├── opsecRoutes.ts          # Simulate, analyze, spending report
│   ├── tronVerify.ts           # On-chain TRX/USDT verification
│   ├── receipts.ts             # ES256 JWT issuance + verification
│   ├── db.ts                   # SQLite schema + CRUD
│   ├── config.ts               # Environment configuration
│   └── *.test.ts               # Tests (15 total)
├── web/src/                    # Frontend (React + Vite)
│   ├── App.tsx                 # 7-tab dashboard UI
│   ├── api.ts                  # 18 typed API functions
│   └── walletErrors.ts         # TronLink error handling
├── scripts/                    # CLI tools + agents
│   ├── go-live.ts              # 9-step live on-chain verification
│   ├── enhanced-agent-demo.ts  # 7-step enhanced agent demo
│   ├── ai-agent.ts             # LLM-powered agent (7 tools)
│   ├── autonomous-agent.ts     # Headless autonomous agent
│   └── tron-permission-setup.ts # TRON multi-sig setup
├── config/                     # Service catalog
├── .env.example                # Complete environment template
├── README.md                   # Comprehensive documentation
└── package.json                # Monorepo (npm workspaces)
```
