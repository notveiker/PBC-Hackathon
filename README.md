# Nile Commerce Gateway — TRON × HTTP 402 (agents & pay-per-use APIs)

A **product-shaped** demo for **AI + commerce on TRON**: priced HTTP APIs return **402 Payment Required**, settlement is verified on **Nile** (TRX or **USDT TRC-20**), the server issues **asymmetrically signed JWT settlement receipts**, and every paid unlock is written to a **SQLite audit log** with a merchant dashboard — not “chat + transfer.”

## Why This Should Score Well

This repo is not just a trading demo. It is a **reusable TRON agent-commerce primitive**:

- **x402 on TRON:** services return `402 Payment Required`, then unlock on verified TRON settlement
- **Marketplace-ready:** multiple merchants can publish priced services through a signed registry
- **Agent-safe:** autonomous buyers verify manifests, enforce spend policy, and refuse suspicious quotes
- **Verifiable:** every unlock maps to an on-chain tx, signed receipt, merchant ledger row, and public verification key
- **Generalizable:** the same rail works for market data, content, analytics, and any fixed-shape API response

If a judge asks “why TRON?”, the answer is:
TRON is not just the payment token here. It is the settlement rail, the verification source of truth, and the safety model through Account Permission Management.

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
| **TronBox / TronIDE / Solidity** | Not required here; the guide’s TronBox flow is for **on-chain** contracts. Optional follow-up: deploy a contract and still settle to the same merchant address. |
| **Further resources** | [TRON Developer Hub](https://developers.tron.network/), TronGrid, explorers — §7.1 / §8. |

## What’s included

| Layer | Details |
|-------|---------|
| **Journey** | Product → Buyer/agent → Merchant tabs; OpenAPI link. |
| **Marketplace registry** | Services are published through `/v1/registry` with merchant identity, recipient address, and price metadata. |
| **Reusable protocol surface** | Generic priced services can be served from `/v1/services/:serviceId` using a JSON service catalog, not only hardcoded demo routes. |
| **Two SKUs** | `/v1/agent/premium-quote` and `/v1/agent/market-depth` (different prices, merchant-aware routing). |
| **Settlement** | Default **USDT** on Nile (override `PAYMENT_ASSET=TRX`). |
| **Receipts** | ES256 JWT (`iss`/`aud`/`exp` + `txId`, `resource`, `payer`) — verify with the public key or JWKS endpoint. |
| **Persistence** | SQLite at `data/commerce.db` (tx uniqueness, merchant history). |
| **Recovery** | Pending payment sessions are persisted in SQLite, so slow Nile confirmations and restarts do not destroy the payment nonce. |
| **Agent CLI** | `npm run agent-demo` — headless 402 smoke / retry with env vars. |

## Fast Judge Pitch

“This project brings x402-style agent payments to TRON. An agent discovers paid services, receives a standardized 402 quote, verifies the merchant and service manifests, pays on Nile, gets an ES256 receipt, and the merchant records the unlock in SQLite. We also added TRON permission controls and risk checks so the agent does not blindly sign malicious payment requests.”

## Judging criteria (how this maps)

| Criterion | How the repo addresses it |
|-----------|---------------------------|
| **Product completeness** | Clear **roles** (Product / Buyer-agent / Merchant), **merchant-aware service registry**, **402 → pay → verify → JWT → session**, SQLite **audit log**, **OpenAPI**. |
| **Real-world usefulness** | **Pay-per-use API** for agents/merchants (micropayment + receipt), **USDT**-style settlement option, **merchant dashboard** with settlement history. |
| **Innovation** | **HTTP 402 + TRON verification** + **publicly verifiable signed receipts** + **merchant-aware registry** + **idempotency** + **agent CLI** — goes beyond “send token in chat.” |
| **Technical correctness** | Server **re-fetches** txs via TronWeb, checks **recipient/amount/asset**, **rejects tx reuse**, stores **unique tx_id**; health exposes **expected Nile** context. |
| **UX + edge cases** | **Network mismatch** banner (TronLink not on Nile), **friendly TronLink errors** (energy / rejected), API **`hint`** on verification failure, **Fees & pitfalls** panel. |
| **Polish** | README, **`.env.example`**, one-command **`npm run dev`**, **demo script** in README + `npm run agent-demo`. |

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

- **API:** http://127.0.0.1:3001  
- **UI:** http://127.0.0.1:5173  
- **OpenAPI:** http://127.0.0.1:3001/openapi.json  

The server reads `.env` from the **repository root**.

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
