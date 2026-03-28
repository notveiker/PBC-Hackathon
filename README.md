# Nile Commerce Gateway v2 — TRON × HTTP 402 × Smart Contracts (agents & pay-per-use APIs)

A **product-shaped** demo for **AI + commerce on TRON**: priced HTTP APIs return **402 Payment Required**, settlement is verified on **Nile** (TRX or **USDT TRC-20**), the server issues **asymmetrically signed JWT settlement receipts**, and every paid unlock is written to a **SQLite audit log** with a merchant dashboard — not “chat + transfer.”

**Core insight:** TRON is not only the payment rail here; it is also the trust and safety layer for autonomous buyers through payment verification, on-chain escrow with dispute resolution, agent identity/reputation, OPSEC tooling, and constrained account permissions.

**Primary demo use case:** an AI trading or analytics agent purchasing premium market data on demand with TRON settlement — with full agentic chargeback protection, on-chain identity, and spending governance.

## v2 Enhancements — 7 of 8 Bounty Directions Covered

| Bounty Direction | How We Cover It |
|---|---|
| **Agentic commerce standards** | x402 flow + enhanced LLM agent with 7 tools + self-registration |
| **UCP on TRON** | Service registry with signed JWT manifests + on-chain AgentRegistry |
| **x402-style payments** | Core HTTP 402 → TRON Nile → JWT receipt flow |
| **Micro-transaction enablement** | Pay-per-call + metered receipts + spending reports + budget tracking |
| **Discovery + trust beyond ERC-8004** | AgentRegistry smart contract with mutable gateway-attested reputation |
| **Security-centric agent execution** | TRON multi-sig permissions + OPSEC simulation + escrow |
| **Agentic chargeback / dispute** | EscrowPayment smart contract with time-lock + arbitrator resolution |
| **OPSEC dev tooling** | Transaction simulator, contract risk analyzer, spending tracker |

### Smart Contracts (new in v2)

- **EscrowPayment.sol** — On-chain escrow with time-locked release and dispute resolution. Buyers deposit TRX, merchants claim after lock period, buyers can dispute, arbitrator resolves by splitting funds.
- **AgentRegistry.sol** — On-chain agent identity with mutable reputation. Self-registration with metadata URI, gateway-attested reputation scores, transaction tracking.

### New API Endpoints (v2)

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/escrow/info` | GET | Contract address and ABI |
| `/v1/escrow/record` | POST | Record on-chain escrow creation |
| `/v1/escrow/:id` | GET | Escrow status (on-chain + local) |
| `/v1/escrow/:id/dispute` | POST | Initiate dispute |
| `/v1/escrow/:id/resolve` | POST | Arbitrator resolves |
| `/v1/escrow` | GET | List escrows |
| `/v1/agents/register` | POST | Register agent identity |
| `/v1/agents/:address` | GET | Agent profile + reputation |
| `/v1/agents` | GET | All registered agents |
| `/v1/opsec/simulate` | POST | Dry-run transaction safety check |
| `/v1/opsec/analyze-contract` | POST | Contract risk analysis |
| `/v1/opsec/spending-report` | GET | Spending summary + budget usage |

### Enhanced AI Agent (v2)

The LLM agent now has 7 tools: `list_services`, `purchase_data`, `simulate_payment`, `register_identity`, `check_reputation`, `spending_report`, plus `create_escrow` support. The agent self-registers on-chain, runs OPSEC checks before every payment, and tracks spending.

### Enhanced Frontend (v2)

Three new UI tabs: **Escrow** (create/dispute/resolve with timeline), **Agents** (register/lookup with reputation badges), **OPSEC** (transaction simulator, contract analyzer, spending dashboard with budget bars).

## Why This Should Score Well

This repo is not just a trading demo. It is a **reusable TRON agent-commerce primitive** covering **7 of 8 bounty directions**:

- **x402 on TRON:** services return `402 Payment Required`, then unlock on verified TRON settlement
- **On-chain escrow:** EscrowPayment smart contract with time-locked release and dispute resolution — the first agentic chargeback layer for pay-per-call commerce
- **Agent identity beyond ERC-8004:** AgentRegistry smart contract with mutable, gateway-attested reputation — agents earn trust through completed transactions
- **OPSEC dev tooling:** transaction simulator, contract risk analyzer, and spending tracker that agents call before signing — a safety net preventing scams
- **Marketplace-ready:** multiple merchants can publish priced services through a signed registry
- **Agent-safe:** autonomous buyers verify manifests, enforce spend policy, run OPSEC simulations, and refuse suspicious quotes
- **Verifiable:** every unlock maps to an on-chain tx, signed receipt, merchant ledger row, and public verification key
- **Generalizable:** the same rail works for market data, content, analytics, and any fixed-shape API response

If a judge asks “why TRON?”, the answer is:
TRON is not just the payment token here. It is the settlement rail, the verification source of truth, the escrow and dispute resolution layer, the agent identity registry, and the safety model through Account Permission Management.

Tooling matches TRON’s own getting-started guidance (**Node 20+**, **TronWeb**, **TronLink**, **Nile**): [Getting Started with TRON Development](https://forum.trondao.org/t/getting-started-with-tron-development/30818).

### How this repo maps to that guide

The forum post is the canonical “stack + testnet + tools” overview. This project uses the pieces that apply to an **off-chain verifier + dApp** (no custom Solidity deploy in-repo):

| Guide topic | This project |
|-------------|----------------|
| **Node.js v20+** | `engines` in `package.json`; run with current LTS. |
| **TronWeb** | Server verifies txs via `tronweb` against `TRON_FULL_HOST` (default [Nile TronGrid](https://www.trongrid.io/)-compatible HTTP API). |
| **TronLink** | Browser pays TRX/USDT; same wallet model as in §3.5 / §4.5 of the guide. |
| **Nile testnet** | All settlement checks use Nile; explorer = [Nile TronScan](https://nile.tronscan.org/#/). |
| **Test tokens** | [Nile faucet](https://nileex.io/join/getJoinPage), [testnet tokens doc](https://developers.tron.network/docs/getting-testnet-tokens-on-tron), or Telegram [TRON Official Developer Group](https://t.me/TronOfficialDevelopersGroupEn) with `!nile <YOUR_TRON_ADDRESS>` as in §6.1. |
| **TRX / Bandwidth & Energy** | USDT TRC-20 transfers need **Energy**; TRX transfers use **Bandwidth** — see UI “Fees & pitfalls” and §3.2 / §7.3 in the guide. |
| **TRC-20** | Default `PAYMENT_ASSET=USDT` (Nile USDT contract aligned with faucet). |
| **Solidity** | **EscrowPayment.sol** and **AgentRegistry.sol** compiled with `solc` and deployed via TronWeb — no TronBox dependency. |
| **Further resources** | [TRON Developer Hub](https://developers.tron.network/), TronGrid, explorers — §7.1 / §8. |

## What’s included

| Layer | Details |
|-------|---------|
| **Journey** | 7-tab UI: Marketplace → Buy → Sell → Trust → Escrow → Agents → OPSEC; OpenAPI link. |
| **Marketplace registry** | Services published via `/v1/registry` with merchant identity, recipient address, price metadata, and signed JWT manifests. |
| **Smart contracts** | **EscrowPayment.sol** (escrow/dispute) + **AgentRegistry.sol** (identity/reputation) deployed on Nile. |
| **OPSEC tooling** | Transaction simulator, contract risk analyzer, spending report with budget tracking. |
| **Two SKUs** | `/v1/agent/premium-quote` and `/v1/agent/market-depth` (different prices, merchant-aware routing). |
| **Settlement** | Default **USDT** on Nile (override `PAYMENT_ASSET=TRX`). |
| **Receipts** | ES256 JWT (`iss`/`aud`/`exp` + `txId`, `resource`, `payer`) — verify with the public key or JWKS endpoint. |
| **Persistence** | SQLite at `data/commerce.db` (tx uniqueness, merchant history, escrows, agent profiles). |
| **Recovery** | Pending payment sessions are persisted in SQLite, so slow Nile confirmations and restarts do not destroy the payment nonce. |
| **Agent CLI** | `npm run agent:enhanced` — 7-step enhanced demo; `npm run agent:ai` — LLM-powered with 7 tools. |

## Fast Judge Pitch

“This project brings x402-style agent payments to TRON with **on-chain escrow, agent identity, and OPSEC tooling** — covering 7 of 8 bounty directions. An AI agent self-registers on our AgentRegistry smart contract, discovers paid services, runs an OPSEC safety simulation, pays through the standard x402 flow (or escrow for high-value purchases), earns on-chain reputation, and tracks spending against budget caps. If dissatisfied, the agent can dispute through the EscrowPayment contract with arbitrator resolution. TRON matters here not just as settlement, but as the escrow layer, the identity registry, and the safety model through Account Permission Management.”

## Judging criteria (how this maps)

| Criterion | How the repo addresses it |
|-----------|---------------------------|
| **End-to-end completeness** | 7-tab UI (Product / Buy / Sell / Trust / Escrow / Agents / OPSEC), **402 → pay → verify → JWT → session**, SQLite **audit log**, **OpenAPI**, smart contracts deployed on Nile. |
| **Security strength** | TRON multi-sig permissions, **OPSEC transaction simulator**, **contract risk analyzer**, **spending caps**, **escrow with dispute resolution**, **signed manifests**. |
| **Standards alignment** | x402 / UCP-inspired design, AgentRegistry beyond ERC-8004, clean REST interfaces, OpenAPI spec, JWKS endpoint for receipt verification. |
| **Innovation** | On-chain escrow for agentic chargeback + mutable reputation registry + OPSEC-as-a-service + LLM agent with 7 tools — **7 of 8 bounty directions in one cohesive system**. |
| **Documentation** | Comprehensive README, `.env.example`, `npm run dev`, `npm run agent:enhanced`, contract deploy scripts, demo videos. |

## Prerequisites

- **Node.js v20+**
- [TronLink](https://www.tronlink.org/) on **Nile Testnet**
- **Merchant** Nile address + **payer** Nile address
- **Test tokens**: TRX for fees; **USDT (Nile)** if using `PAYMENT_ASSET=USDT` — [Nile faucet](https://nileex.io/join/getJoinPage), [testnet tokens doc](https://developers.tron.network/docs/getting-testnet-tokens-on-tron), or Telegram `!nile <ADDRESS>` per the forum guide.

## Quick start

```bash
cp .env.example .env
# Required: MERCHANT_TRON_ADDRESS=<your primary Nile merchant Base58>
# Optional: SECONDARY_MERCHANT_TRON_ADDRESS=<second merchant for marketplace demos>
# Optional: npm run receipt-keys   # generate ES256 receipt keys for .env
# Optional for persistent receipt identity across restarts:
# openssl ecparam -name prime256v1 -genkey -noout -out receipt-private.pem
# openssl ec -in receipt-private.pem -pubout -out receipt-public.pem
npm install
npm run dev
```

### Deploy smart contracts (optional, for on-chain features)

```bash
# Compile Solidity contracts
npm run contracts:compile

# Deploy to Nile testnet (requires DEPLOYER_PRIVATE_KEY or GATEWAY_PRIVATE_KEY in .env)
npm run contracts:deploy
# → writes contracts/deployed.json with addresses
# → add ESCROW_CONTRACT_ADDRESS and AGENT_REGISTRY_CONTRACT_ADDRESS to .env

# Verify deployed contracts
npm run contracts:verify
```

### Run the enhanced agent demo

```bash
# Requires: NILE_PAYER_PRIVATE_KEY in .env (funded Nile account)
npm run agent:enhanced
# → 7-step demo: register → discover → simulate → pay → verify → reputation → spending
```

### Full live on-chain verification (9 steps)

```bash
# Deploys contracts, registers agent, pays on-chain, creates escrow, updates reputation
# Requires: GATEWAY_PRIVATE_KEY + NILE_PAYER_PRIVATE_KEY in .env, server running
npm run go-live
# → Produces verifiable tx hashes on Nile Tronscan for every step
```

- **API:** http://127.0.0.1:3001
- **UI:** http://127.0.0.1:5173 (7 tabs: Marketplace / Buy / Sell / Trust / Escrow / Agents / OPSEC)
- **OpenAPI:** http://127.0.0.1:3001/openapi.json

The server reads `.env` from the **repository root**.

### curl walkthrough (raw x402 flow)

```bash
# 1. Request data → get HTTP 402 with payment requirements
curl -s http://127.0.0.1:3001/v1/agent/premium-quote | jq .

# 2. Copy the nonce from the response, pay on Nile (TRX or USDT), then verify:
curl -s http://127.0.0.1:3001/v1/agent/premium-quote \
  -H "X-Payment-Nonce: <nonce-from-step-1>" \
  -H "X-Payment-Tx-Id: <your-nile-txid>" | jq .

# 3. Re-use the JWT receipt for session access (no second payment):
curl -s http://127.0.0.1:3001/v1/agent/premium-quote \
  -H "Authorization: Bearer <accessToken-from-step-2>" | jq .

# 4. OPSEC: simulate a payment before signing
curl -s -X POST http://127.0.0.1:3001/v1/opsec/simulate \
  -H "Content-Type: application/json" \
  -d '{"to":"<merchant-address>","amount":"1000000","asset":"TRX"}' | jq .

# 5. Check agent reputation
curl -s http://127.0.0.1:3001/v1/agents/<agent-address> | jq .
```

## Public deployment

The easiest shareable setup is:

- **Frontend** on **Vercel**
- **Backend** on **Railway** or **Render**

### 1. Deploy the backend

Deploy the repository as a Node service and run:

```bash
npm install
npm run start -w server
```

Set backend env vars:

```bash
MERCHANT_TRON_ADDRESS=...
SECONDARY_MERCHANT_TRON_ADDRESS=...   # optional
PAYMENT_ASSET=USDT
TRON_FULL_HOST=https://nile.trongrid.io
TRONGRID_API_KEY=...                  # optional but recommended
DATABASE_PATH=data/commerce.db
RECEIPT_PRIVATE_KEY_PEM=...
RECEIPT_PUBLIC_KEY_PEM=...
CORS_ALLOWED_ORIGINS=https://your-frontend.vercel.app
```

After deploy, note the public backend URL, for example:

```bash
https://your-backend.up.railway.app
```

### 2. Deploy the frontend to Vercel

Use the `web/` workspace as the Vercel project root.

Build settings:

```bash
Install command: npm install
Build command: npm run build -w web
Output directory: web/dist
```

Set this frontend env var in Vercel:

```bash
VITE_API_BASE_URL=https://your-backend.up.railway.app
```

That makes the frontend call the public backend instead of the local dev proxy.

### 3. Share one URL

Once both are deployed, send the Vercel URL. The UI will talk to the public backend and the full marketplace flow will be available to anyone with that link.

## Judge / video flow (complete journey)

1. **Product** tab — explain pay-per-use + TRON settlement.
2. **Buyer / agent** — choose resource → **Request priced resource** → **402** + `paymentRequired`.
3. **Pay** — **Pay with TronLink (USDT)** (or TRX if configured) → copy **txid** if needed → **Verify & unlock** → **200** + `settlementReceipt` JWT + `data`.
4. **Merchant** — refresh → see row in **Recent settlements** + summary JSON.
5. Show **tx** on [Nile TronScan](https://nile.tronscan.org/).

**Artifacts to show:** explorer link, JWT payload, public verification key at `/.well-known/jwks.json`, SQLite file or `GET /v1/merchant/payments`.

### 90-second version

1. Open `/v1/registry` and show multiple signed services and merchants.
2. Hit one service and show the `402 paymentRequired` response.
3. Pay and unlock.
4. Show the tx on TronScan.
5. Show the signed receipt plus `/.well-known/jwks.json`.
6. Refresh merchant payments and point to the new row.

That sequence lands the entire bounty rubric very quickly: discovery, micropayment, verification, security, and proof.

## Headless agent

```bash
# 402 probe (no wallet)
npm run agent-demo

# After paying manually, verify (example)
RESOURCE_PATH=/v1/agent/premium-quote NONCE=<nonce> TXID=<txid> npm run agent-demo
```

### Fully autonomous agent (no TronLink clicks)

The **browser UI** uses TronLink because, in a real product, signing should stay in the user’s wallet. For a **true agent loop** (402 → sign → broadcast → retry), use a **Nile payer private key** in `.env` (demo only — never commit):

```bash
# .env: NILE_PAYER_PRIVATE_KEY=<64 hex chars for your Nile PAYER account>
npm run agent:auto
# optional: RESOURCE_PATH=/v1/agent/market-depth API_BASE=http://127.0.0.1:3001 npm run agent:auto
```

Both autonomous agent paths now enforce a local payment policy before signing:
they pin the expected `scheme`, `network`, `resource path`, `merchant address`,
and reject any quote above configurable USDT/TRX ceilings. That matters for the
hackathon story because it turns the agent from "blind spender" into a
policy-constrained buyer.

## Environment (see `.env.example`)

| Variable | Purpose |
|----------|---------|
| `MERCHANT_TRON_ADDRESS` | **Required.** Primary merchant wallet. |
| `SECONDARY_MERCHANT_TRON_ADDRESS` | Optional second merchant to demonstrate marketplace routing across sellers. |
| `PAYMENT_ASSET` | `USDT` (default) or `TRX`. |
| `PRICE_PREMIUM_USDT_UNITS` / `PRICE_DEPTH_USDT_UNITS` | USDT minimal units (6 decimals). |
| `RECEIPT_PRIVATE_KEY_PEM` / `RECEIPT_PUBLIC_KEY_PEM` | Optional ES256 receipt keypair; set both for stable verification across restarts. |
| `DATABASE_PATH` | SQLite path (default `data/commerce.db`). |
| `TRON_NILE_USDT_CONTRACT` | Override if your Nile USDT differs. |
| `ALLOWED_PAYER_ADDRESSES` | Optional payer allowlist. |
| `NILE_PAYER_PRIVATE_KEY` | **Autonomous agent only** (`npm run agent:auto`, `npm run agent:ai`). Nile payer hex key; never commit. |
| `ANTHROPIC_API_KEY` | Optional for `npm run agent:ai` when using Anthropic. |
| `OPENAI_API_KEY` | Optional for `npm run agent:ai` when using OpenAI or auto fallback. |
| `AI_PROVIDER` | `auto` (default), `anthropic`, `openai`, or `demo` for `npm run agent:ai`. |
| `EXPECTED_PAYMENT_SCHEME` / `EXPECTED_SETTLEMENT_NETWORK` | Agent-side trust policy for 402 quotes; defaults to `tron-settlement` / `tron-nile`. |
| `EXPECTED_MERCHANT_ADDRESSES` | Optional comma-separated merchant allowlist for marketplace-safe agent payments. |
| `AGENT_MAX_USDT_UNITS` / `AGENT_MAX_TRX_SUN` | Agent-side spending caps; rejects oversized payment quotes before signing. |
| `AGENT_MIN_TRUST_SCORE` | Refuse/warn on merchants below the local trust threshold. |

## Project layout

- `server/` — Fastify, TronWeb verification, JWT receipts, SQLite, rate limiting on paid routes.
- `web/` — Vite + React (product, buyer, merchant, security).
- `scripts/agent-demo.mjs` — CLI 402 probe / manual retry.
- `scripts/autonomous-agent.ts` — `npm run agent:auto` — full agent loop with env private key.
- `scripts/ai-agent.ts` — `npm run agent:ai` — Anthropic or OpenAI agent loop with paid tool calls.
- `scripts/generate-receipt-keys.mjs` — `npm run receipt-keys` — generate ES256 receipt keys for `.env`.
- `config/service-catalog.example.json` — example marketplace catalog for merchant/service onboarding without code edits.

## Reusability

This repo now has two layers:

- **Protocol / platform layer:** generic priced services, registry, receipts, risk logging, merchant identity, payment verification
- **Demo layer:** TRX/USDT market data plus an example paid content service

That matters for review because judges can see the platform is reusable beyond the sample vertical.

## Maintainer check (hackathon bar)

**Strengths (competitive):**

- **End-to-end story:** 402 → TRON verify → JWT receipt → merchant audit log → Tronscan — matches “not chat + transfer.”
- **Generalized commerce primitive:** `/v1/registry` now models a small marketplace with merchant identity and per-service recipients, not a single hard-coded seller.
- **Operational resilience:** pending payment sessions now survive process restarts and can be reconciled after slow confirmations, which makes the live demo much less fragile.
- **Trust + OPSEC:** registry entries now include signed merchant/service manifests, trust metadata, and a risk-event feed; the AI agent verifies manifests and refuses suspicious quotes before paying.
- **TRON-native:** USDT/TRX, Nile, Bandwidth/Energy called out; optional **autonomous agent** (`npm run agent:auto`).
- **Safety / abuse:** Tx **replay** blocked (SQLite), **idempotency scoped per resource** (no cross-SKU mix-ups), **global rate limit** (health/OpenAPI exempt).
- **Polish:** OpenAPI, README judging table, `npm run check` (build + tests), `LICENSE` (MIT).

**What still depends on you:** A crisp **demo video** (under ~3 min), **Nile** TronLink, funded wallets, and a **GitHub** repo link. No codebase replaces that.

**Optional stretch (not required):** On-chain escrow contract, TRON permission demo tx, or Bank of AI / x402 cross-reference in README.

## Security & TRON Account Permission Management

### Constrained agent key setup

The biggest risk in agentic commerce: a compromised agent key drains your entire wallet. TRON's native Account Permission Management solves this by letting you create a **hot agent key that can only pay** — it cannot update permissions, freeze funds, vote, or trigger arbitrary contracts.

```
TRON Account Architecture
─────────────────────────
OWNER permission (threshold 1)
└─ cold wallet key  (weight 1) — kept offline, never in agent code

ACTIVE permission "agent-active" (threshold 1)
└─ agent hot key  (weight 1)
   Allowed: TransferContract + TriggerSmartContract (TRX + USDT)
   Blocked: UpdateAccountPermission, FreezeBalance, VoteWitness, ...
```

Run the demo:

```bash
# Query current permissions (read-only):
OWNER_ADDRESS=T...  npm run permission-setup -- --query

# Apply constrained agent key (writes on-chain tx):
OWNER_ADDRESS=T...  OWNER_PRIVATE_KEY=<64hex>  AGENT_ADDRESS=T...  npm run permission-setup
```

The script (`scripts/tron-permission-setup.ts`) builds an `updateAccountPermissions` transaction, signs it with the owner key, broadcasts to Nile, and re-queries the account to confirm the new permissions. The `operations` bitmask is set to allow only `TransferContract` (bit 1) and `TriggerSmartContract` (bit 31) — the exact two operations an agent needs to pay merchants.

### Threat model summary

| Attack | Mitigation |
|--------|-----------|
| Wrong recipient | On-chain re-verification of recipient === merchant address |
| Underpayment | BigInt comparison: amount ≥ required minimal units |
| Tx replay | SQLite UNIQUE on tx_id; checked before settlement insert |
| Nonce brute-force | 16 random bytes (2¹²⁸ space), 30-min TTL |
| Invalid txid injection | Regex: 64 hex chars validated before any network call |
| Cross-SKU confusion | Idempotency key scoped per resource path |
| JWT forgery | ES256 + issuer + audience enforced via `jose`; public verification key exposed |
| Mainnet tx | Server pinned to Nile TronGrid; mainnet txids fail |
| Rate limit abuse | 240 req/min via `@fastify/rate-limit` |

### OPSEC rules for agent developers

1. **Never use your owner key in agent code** — create a separate hot key and constrain it.
2. **Validate 402 responses before signing** — check `x402Version`, `scheme`, `network`, and that the recipient is a known address.
3. **Cap payment amounts** — reject `paymentRequired.amount` above a configurable ceiling.
4. **Pin merchant addresses** — never accept an arbitrary recipient from an API response.
5. **Store JWT receipts** — they are your proof of payment for dispute resolution.

## Further reading

- [TRON Developer Hub](https://developers.tron.network/)
- [TronWeb](https://tronweb.network/docu/docs/intro/)
- [Multi-signature / permissions](https://developers.tron.network/docs/multi-signature)

## License

MIT (hackathon / demonstration use).
