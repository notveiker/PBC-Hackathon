/**
 * AI Agent — LLM-powered agentic commerce on TRON
 *
 * The agent receives a task, discovers available paid APIs via /v1/registry,
 * autonomously pays for the data it needs using TRON (Nile testnet), and
 * uses the purchased data to answer the question.
 *
 * This is the "AI & Agentic Commerce" demo core: a real LLM deciding what
 * to buy, paying on-chain without human intervention, and reasoning over
 * the result.
 *
 * Prerequisites:
 *   - API server running: npm run dev -w server
 *   - ANTHROPIC_API_KEY or OPENAI_API_KEY in .env
 *   - NILE_PAYER_PRIVATE_KEY in .env (Nile payer account, funded with USDT+TRX)
 *
 * Usage:
 *   npm run agent:ai
 *   TASK="Is now a good time to buy TRX?" npm run agent:ai
 *   RESOURCE_PATH=/v1/agent/market-depth npm run agent:ai   # force a specific service
 */

import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { appendFile, mkdir } from "node:fs/promises";
import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, jwtVerify } from "jose";
import TronWebModule from "tronweb";

const { TronWeb } = TronWebModule;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:3001";
const FULL_HOST = process.env.TRON_FULL_HOST ?? "https://nile.trongrid.io";
const PAYER_KEY = process.env.NILE_PAYER_PRIVATE_KEY?.trim();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const AI_PROVIDER = (process.env.AI_PROVIDER ?? "auto").trim().toLowerCase();
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const PAYMENT_VERIFY_MAX_RETRIES = Number(process.env.PAYMENT_VERIFY_MAX_RETRIES ?? "18");
const PAYMENT_VERIFY_DELAY_MS = Number(process.env.PAYMENT_VERIFY_DELAY_MS ?? "5000");
const EXPECTED_PAYMENT_SCHEME = process.env.EXPECTED_PAYMENT_SCHEME ?? "tron-settlement";
const EXPECTED_SETTLEMENT_NETWORK = process.env.EXPECTED_SETTLEMENT_NETWORK ?? "tron-nile";
const EXPECTED_MERCHANT_ADDRESSES = [
  process.env.MERCHANT_TRON_ADDRESS?.trim(),
  process.env.SECONDARY_MERCHANT_TRON_ADDRESS?.trim(),
  ...(process.env.EXPECTED_MERCHANT_ADDRESSES ?? "")
    .split(",")
    .map((value) => value.trim()),
].filter((value): value is string => Boolean(value));
const AGENT_MAX_USDT_UNITS = BigInt(process.env.AGENT_MAX_USDT_UNITS ?? "2000000");
const AGENT_MAX_TRX_SUN = BigInt(process.env.AGENT_MAX_TRX_SUN ?? "2000000");
const AGENT_MIN_TRUST_SCORE = Number(process.env.AGENT_MIN_TRUST_SCORE ?? "70");
const AGENT_RISK_LOG_PATH = process.env.AGENT_RISK_LOG_PATH ?? path.join(root, "data", "agent-risk-events.jsonl");
const TASK =
  process.env.TASK ??
  "Analyze the current TRX/USDT market. What are the live bid and ask prices, " +
    "what does the order book depth look like, and what would you advise a small trader right now?";

// ── Types ─────────────────────────────────────────────────────────────────────

type PaymentRequired = {
  x402Version?: number;
  scheme?: string;
  network?: string;
  resource?: string;
  nonce: string;
  amount: string;
  amountAsset: "TRX" | "USDT";
  recipient: string;
  productName?: string;
};

type Error402Body = {
  paymentRequired?: PaymentRequired;
  error?: string;
  message?: string;
};

type RegistryMerchant = {
  id: string;
  name: string;
  address: string;
  trust?: {
    verificationStatus?: string;
    trustScore?: number;
    riskTier?: string;
    controls?: string[];
  };
  manifestJwt?: string;
};

type RegistryService = {
  id: string;
  path: string;
  merchant: RegistryMerchant;
  price: { asset: "TRX" | "USDT"; amount: string; humanReadable?: string };
  payment: { scheme: string; network: string; recipient: string };
  trust?: {
    riskCategory?: string;
    safeguards?: string[];
    minVerification?: string;
  };
  manifestJwt?: string;
};

type RegistryPayload = {
  services?: RegistryService[];
  merchants?: RegistryMerchant[];
};

type ToolResult = unknown;
type QuotePayload = {
  quote?: {
    symbol?: string;
    bid?: number;
    ask?: number;
    spread?: number;
    spreadBps?: number;
    bidQty?: number;
    askQty?: number;
    ts?: string;
  };
  settlementTx?: string;
};

type DepthLevel = { px: number; sz: number };
type DepthPayload = {
  depth?: {
    bids?: DepthLevel[];
    asks?: DepthLevel[];
    ts?: string;
  };
  settlementTx?: string;
};

type RiskEvaluation = {
  action: "allow" | "warn" | "refuse";
  severity: "low" | "medium" | "high";
  reason: string;
  details: Record<string, unknown>;
};

let registryCache: RegistryPayload | null = null;
let jwksCache: { keys: Record<string, unknown>[] } | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function dim(s: string) { return `\x1b[2m${s}\x1b[0m`; }
function bold(s: string) { return `\x1b[1m${s}\x1b[0m`; }
function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string) { return `\x1b[33m${s}\x1b[0m`; }
function cyan(s: string) { return `\x1b[36m${s}\x1b[0m`; }

function hasLowCreditAnthropicError(error: unknown): boolean {
  const message =
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof (error as { error?: { error?: { message?: string } } }).error?.error?.message === "string"
      ? (error as { error: { error: { message: string } } }).error.error.message
      : error instanceof Error
        ? error.message
        : "";

  return message.toLowerCase().includes("credit balance is too low");
}

function hasOpenAIQuotaError(error: unknown): boolean {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: string }).code === "string"
      ? (error as { code: string }).code
      : "";

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return code === "insufficient_quota" || message.includes("exceeded your current quota");
}

function formatPrice(value: number | undefined): string {
  return typeof value === "number" ? value.toFixed(6) : "n/a";
}

function formatQty(value: number | undefined): string {
  return typeof value === "number" ? value.toFixed(0) : "n/a";
}

function sumLevels(levels: DepthLevel[] | undefined): number {
  return (levels ?? []).reduce((sum, level) => sum + level.sz, 0);
}

function extractData<T>(result: unknown): T | null {
  if (
    typeof result === "object" &&
    result !== null &&
    "data" in result &&
    typeof (result as { data?: unknown }).data === "object"
  ) {
    return ((result as { data?: unknown }).data as T) ?? null;
  }
  return null;
}

function extractTxid(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (typeof result !== "object" || result === null) {
    return "";
  }

  const candidate = result as {
    txid?: string;
    txID?: string;
    transaction?: { txID?: string };
    result?: { txid?: string; txID?: string };
  };

  return (
    candidate.txid ??
    candidate.txID ??
    candidate.transaction?.txID ??
    candidate.result?.txid ??
    candidate.result?.txID ??
    ""
  );
}

async function fetchRegistrySnapshot(): Promise<RegistryPayload> {
  if (registryCache) return registryCache;
  const r = await fetch(`${API_BASE}/v1/registry`);
  if (!r.ok) throw new Error(`Failed to fetch registry: HTTP ${r.status}`);
  registryCache = await r.json() as RegistryPayload;
  return registryCache;
}

async function fetchJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  if (jwksCache) return jwksCache;
  const r = await fetch(`${API_BASE}/.well-known/jwks.json`);
  if (!r.ok) throw new Error(`Failed to fetch JWKS: HTTP ${r.status}`);
  jwksCache = await r.json() as { keys: Record<string, unknown>[] };
  return jwksCache;
}

async function recordRiskEvent(event: {
  action: string;
  severity: string;
  reason: string;
  servicePath?: string;
  merchantId?: string;
  details: Record<string, unknown>;
}): Promise<void> {
  await mkdir(path.dirname(AGENT_RISK_LOG_PATH), { recursive: true });
  await appendFile(
    AGENT_RISK_LOG_PATH,
    JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
    }) + "\n",
    "utf8"
  );
}

async function verifyManifestJwt(token: string | undefined, subject: string): Promise<boolean> {
  if (!token) return false;
  const jwks = await fetchJwks();
  const localJwks = createLocalJWKSet(jwks);
  try {
    await jwtVerify(token, localJwks, {
      issuer: "tron-commerce-gateway",
      audience: "agent-client",
      subject,
      algorithms: ["ES256"],
    });
    return true;
  } catch {
    return false;
  }
}

async function evaluatePaymentRisk(
  pr: PaymentRequired,
  servicePath: string
): Promise<RiskEvaluation> {
  const registry = await fetchRegistrySnapshot();
  const service = registry.services?.find((item) => item.path === servicePath);
  if (!service) {
    return {
      action: "refuse",
      severity: "high",
      reason: "service_not_in_registry",
      details: { servicePath },
    };
  }

  const merchant =
    registry.merchants?.find((item) => item.id === service.merchant.id) ??
    service.merchant;
  const merchantManifestOk = await verifyManifestJwt(merchant.manifestJwt, `merchant:${merchant.id}`);
  const serviceManifestOk = await verifyManifestJwt(service.manifestJwt, `service:${service.id}`);
  const trustScore = merchant.trust?.trustScore ?? 0;
  const reasons: string[] = [];
  let severity: RiskEvaluation["severity"] = "low";
  let action: RiskEvaluation["action"] = "allow";

  if (pr.scheme !== service.payment.scheme) reasons.push("scheme_mismatch");
  if (pr.network !== service.payment.network) reasons.push("network_mismatch");
  if (pr.recipient !== service.payment.recipient) reasons.push("recipient_mismatch");
  if (pr.amountAsset !== service.price.asset) reasons.push("asset_mismatch");
  if (pr.amount !== service.price.amount) reasons.push("price_mismatch");
  if (pr.resource !== service.path) reasons.push("resource_mismatch");
  if (!merchantManifestOk) reasons.push("merchant_manifest_invalid");
  if (!serviceManifestOk) reasons.push("service_manifest_invalid");
  if (trustScore < AGENT_MIN_TRUST_SCORE) reasons.push("trust_score_below_threshold");
  if (merchant.trust?.riskTier === "high") reasons.push("merchant_risk_tier_high");

  if (reasons.some((reason) => reason.includes("mismatch") || reason.includes("invalid"))) {
    severity = "high";
    action = "refuse";
  } else if (reasons.length > 0) {
    severity = "medium";
    action = "warn";
  }

  return {
    action,
    severity,
    reason: reasons[0] ?? "policy_ok",
    details: {
      reasons,
      merchantId: merchant.id,
      merchantName: merchant.name,
      trustScore,
      merchantManifestOk,
      serviceManifestOk,
      quote: pr,
    },
  };
}

async function validatePaymentRequest(pr: PaymentRequired, servicePath: string): Promise<void> {
  if (pr.x402Version !== 1) {
    throw new Error(`Refusing payment: unsupported x402Version ${String(pr.x402Version)}`);
  }
  if (pr.scheme !== EXPECTED_PAYMENT_SCHEME) {
    throw new Error(
      `Refusing payment: expected scheme ${EXPECTED_PAYMENT_SCHEME}, got ${String(pr.scheme)}`
    );
  }
  if (pr.network !== EXPECTED_SETTLEMENT_NETWORK) {
    throw new Error(
      `Refusing payment: expected network ${EXPECTED_SETTLEMENT_NETWORK}, got ${String(pr.network)}`
    );
  }
  if (pr.resource !== servicePath) {
    throw new Error(
      `Refusing payment: resource mismatch. expected ${servicePath}, got ${String(pr.resource)}`
    );
  }
  if (EXPECTED_MERCHANT_ADDRESSES.length > 0 && !EXPECTED_MERCHANT_ADDRESSES.includes(pr.recipient)) {
    throw new Error(
      `Refusing payment: recipient ${pr.recipient} is not in EXPECTED_MERCHANT_ADDRESSES`
    );
  }

  const amount = BigInt(pr.amount);
  if (pr.amountAsset === "USDT" && amount > AGENT_MAX_USDT_UNITS) {
    throw new Error(
      `Refusing payment: USDT amount ${pr.amount} exceeds agent cap ${AGENT_MAX_USDT_UNITS.toString()}`
    );
  }
  if (pr.amountAsset === "TRX" && amount > AGENT_MAX_TRX_SUN) {
    throw new Error(
      `Refusing payment: TRX amount ${pr.amount} exceeds agent cap ${AGENT_MAX_TRX_SUN.toString()}`
    );
  }

  const risk = await evaluatePaymentRisk(pr, servicePath);
  await recordRiskEvent({
    action: risk.action,
    severity: risk.severity,
    reason: risk.reason,
    servicePath,
    merchantId: typeof risk.details.merchantId === "string" ? risk.details.merchantId : undefined,
    details: risk.details,
  });
  if (risk.action === "warn") {
    console.warn(yellow(`  [risk] warning: ${risk.reason}`));
  }
  if (risk.action === "refuse") {
    throw new Error(`Refusing payment: ${risk.reason}`);
  }
}

// ── Tool implementations ───────────────────────────────────────────────────────

async function listServices(): Promise<unknown> {
  console.log(dim("  [tool] GET /v1/registry"));
  const r = await fetch(`${API_BASE}/v1/registry`);
  if (!r.ok) throw new Error(`Registry request failed: ${r.status}`);
  const data = await r.json();
  registryCache = data as RegistryPayload;
  console.log(dim(`  [tool] Registry returned ${(data as { services?: unknown[] }).services?.length ?? 0} services`));
  return data;
}

async function purchaseData(
  servicePath: string,
  tronWeb: InstanceType<typeof TronWeb>,
  usdtContract: string
): Promise<unknown> {
  const from = tronWeb.defaultAddress.base58;
  if (!from) {
    throw new Error("Payer wallet has no default TRON address loaded");
  }
  const idem = `ai-agent-${Date.now()}`;

  // Step 1 — request resource, expect 402
  console.log(dim(`  [tool] GET ${servicePath} (expecting 402)`));
  const r402 = await fetch(`${API_BASE}${servicePath}`, {
    headers: { "Idempotency-Key": idem },
  });

  if (r402.status !== 402) {
    const body = await r402.json().catch(() => ({}));
    throw new Error(`Expected 402, got ${r402.status}: ${JSON.stringify(body)}`);
  }

  const body402 = (await r402.json()) as Error402Body;
  const pr = body402.paymentRequired;
  if (!pr) throw new Error("402 response missing paymentRequired");
  await validatePaymentRequest(pr, servicePath);

  console.log(yellow(`  [pay]  ${pr.amountAsset} ${pr.amount} → ${pr.recipient.slice(0, 12)}...`));
  console.log(dim(`         nonce=${pr.nonce}`));

  // Step 2 — broadcast payment on TRON Nile
  let txid: string;

  if (pr.amountAsset === "TRX") {
    const amountSun = Number(pr.amount);
    const tx = await tronWeb.transactionBuilder.sendTrx(pr.recipient, amountSun, from);
    const signed = await tronWeb.trx.sign(tx);
    const sent = await tronWeb.trx.sendRawTransaction(signed);
    txid = extractTxid(sent);
  } else {
    const inst = await tronWeb.contract().at(usdtContract);
    const sent = await inst.transfer(pr.recipient, pr.amount).send({ feeLimit: 150_000_000 });
    txid = extractTxid(sent);
  }

  if (!txid) throw new Error("Payment broadcast returned no txid");
  console.log(green(`  [pay]  broadcast ok txid=${txid}`));
  console.log(dim(`         https://nile.tronscan.org/#/transaction/${txid}`));

  // Step 3 — retry with proof (up to 6 attempts, incremental backoff)
  const maxRetries = Math.max(1, PAYMENT_VERIFY_MAX_RETRIES);
  const delayMs = Math.max(1000, PAYMENT_VERIFY_DELAY_MS);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(dim(`  [wait] ${delayMs}ms (attempt ${attempt}/${maxRetries})`));
    await sleep(delayMs);

    const r = await fetch(`${API_BASE}${servicePath}`, {
      headers: {
        "X-Payment-Nonce": pr.nonce,
        "X-Payment-Tx-Id": txid,
        "Idempotency-Key": idem,
      },
    });

    const body = await r.json().catch(() => ({})) as { error?: string; data?: unknown; settlementReceipt?: unknown };

    if (r.status === 200) {
      console.log(green(`  [pay]  verified ✓ block=${(body as { verification?: { blockNumber?: number } }).verification?.blockNumber ?? "?"}`));
      return body;
    }
    if (r.status === 409) {
      console.log(green("  [pay]  already settled (idempotent) ✓"));
      return body;
    }
    if (r.status === 402 && body.error === "payment_verification_failed") {
      console.log(dim("  [wait] not yet confirmed, retrying..."));
      continue;
    }
    throw new Error(`Unexpected response ${r.status}: ${JSON.stringify(body)}`);
  }

  throw new Error(
    `Max retries exceeded — transaction not confirmed in time. nonce=${pr.nonce} txid=${txid}`
  );
}

async function executeTool(
  toolName: string,
  input: { service_path?: string },
  tronWeb: InstanceType<typeof TronWeb>,
  usdtContract: string
): Promise<ToolResult> {
  if (toolName === "list_services") {
    return listServices();
  }
  if (toolName === "purchase_data") {
    if (!input.service_path) {
      return { error: "purchase_data requires service_path" };
    }
    return purchaseData(input.service_path, tronWeb, usdtContract);
  }
  return { error: `Unknown tool: ${toolName}` };
}

// ── Claude tool definitions ───────────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: "list_services",
    description:
      "Discover available paid market data APIs on this TRON commerce gateway. " +
      "Returns each service's path, description, price, and how to pay. " +
      "Call this first so you know what's available before purchasing.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "purchase_data",
    description:
      "Pay for and retrieve data from a paid service using TRON. " +
      "Handles the full payment flow: sends the required USDT/TRX on Nile, " +
      "waits for on-chain confirmation, and returns the purchased data " +
      "along with a verifiable JWT settlement receipt. " +
      "Use the service path from list_services.",
    input_schema: {
      type: "object" as const,
      properties: {
        service_path: {
          type: "string",
          description:
            "The API path of the service to purchase (e.g. /v1/agent/premium-quote). " +
            "Get this from list_services.",
        },
      },
      required: ["service_path"],
    },
  },
];

const openAITools = [
  {
    type: "function",
    function: {
      name: "list_services",
      description:
        "Discover available paid market data APIs on this TRON commerce gateway. " +
        "Returns each service's path, description, price, and how to pay. " +
        "Call this first so you know what's available before purchasing.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "purchase_data",
      description:
        "Pay for and retrieve data from a paid service using TRON. " +
        "Handles the full payment flow: sends the required USDT/TRX on Nile, " +
        "waits for on-chain confirmation, and returns the purchased data " +
        "along with a verifiable JWT settlement receipt. " +
        "Use the service path from list_services.",
      parameters: {
        type: "object",
        properties: {
          service_path: {
            type: "string",
            description:
              "The API path of the service to purchase (e.g. /v1/agent/premium-quote). " +
              "Get this from list_services.",
          },
        },
        required: ["service_path"],
        additionalProperties: false,
      },
    },
  },
] as const;

// ── Agent loop ────────────────────────────────────────────────────────────────

async function runAgent(
  anthropic: Anthropic,
  tronWeb: InstanceType<typeof TronWeb>,
  usdtContract: string,
  task: string
): Promise<void> {
  console.log(bold("\n🤖 AI Agent starting"));
  console.log(`   Payer : ${tronWeb.defaultAddress.base58}`);
  console.log(`   Task  : ${task}\n`);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: task },
  ];

  const systemPrompt =
    "You are an autonomous AI trading assistant with access to paid real-time market data APIs " +
    "settled on the TRON blockchain. " +
    "When given a market analysis task, always start by calling list_services to discover " +
    "what data is available and at what cost. " +
    "Then purchase the data you need to answer the question thoroughly. " +
    "Be specific with numbers from the data you retrieve — don't be vague. " +
    "After purchasing data, provide a clear, concise analysis that directly answers the user's question. " +
    "Always mention the settlement transaction ID(s) as proof that real on-chain payments were made.";

  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: systemPrompt,
      tools,
      messages,
    });

    // Collect any text blocks to print as we go
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(cyan("\n🤖 " + block.text));
      }
    }

    if (response.stop_reason === "end_turn") {
      break;
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      // Add assistant turn to history
      messages.push({ role: "assistant", content: response.content });

      // Execute all tool calls (may be parallel)
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        console.log(yellow(`\n🔧 Calling tool: ${bold(toolUse.name)}`));
        if (toolUse.name === "purchase_data") {
          const input = toolUse.input as { service_path: string };
          console.log(`   service: ${input.service_path}`);
        }

        let result: unknown;
        try {
          result = await executeTool(
            toolUse.name,
            toolUse.input as { service_path?: string },
            tronWeb,
            usdtContract
          );
        } catch (e) {
          console.error(`   ✗ Tool error: ${String(e)}`);
          result = { error: String(e) };
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Unexpected stop reason
    console.warn(`Unexpected stop_reason: ${response.stop_reason}`);
    break;
  }

  console.log("\n" + dim("─".repeat(60)));
  console.log(dim("Agent run complete."));
}

async function runOpenAIAgent(
  openai: OpenAI,
  tronWeb: InstanceType<typeof TronWeb>,
  usdtContract: string,
  task: string
): Promise<void> {
  console.log(bold("\n🤖 AI Agent starting"));
  console.log(`   Provider: OpenAI (${OPENAI_MODEL})`);
  console.log(`   Payer   : ${tronWeb.defaultAddress.base58}`);
  console.log(`   Task    : ${task}\n`);

  const systemPrompt =
    "You are an autonomous AI trading assistant with access to paid real-time market data APIs " +
    "settled on the TRON blockchain. " +
    "When given a market analysis task, always start by calling list_services to discover " +
    "what data is available and at what cost. " +
    "Then purchase the data you need to answer the question thoroughly. " +
    "Be specific with numbers from the data you retrieve; do not be vague. " +
    "After purchasing data, provide a clear, concise analysis that directly answers the user's question. " +
    "Always mention the settlement transaction ID(s) as proof that real on-chain payments were made.";

  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
  ];

  while (true) {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      tools: openAITools,
      tool_choice: "auto",
    });

    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error("OpenAI returned no message");
    }

    if (message.content?.trim()) {
      console.log(cyan("\n🤖 " + message.content));
    }

    if (!message.tool_calls?.length) {
      break;
    }

    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.tool_calls,
    });

    for (const toolCall of message.tool_calls) {
      console.log(yellow(`\n🔧 Calling tool: ${bold(toolCall.function.name)}`));

      let input: { service_path?: string } = {};
      try {
        input = toolCall.function.arguments
          ? (JSON.parse(toolCall.function.arguments) as { service_path?: string })
          : {};
      } catch (error) {
        console.error(`   ✗ Invalid tool arguments: ${String(error)}`);
      }

      if (toolCall.function.name === "purchase_data" && input.service_path) {
        console.log(`   service: ${input.service_path}`);
      }

      let result: ToolResult;
      try {
        result = await executeTool(toolCall.function.name, input, tronWeb, usdtContract);
      } catch (error) {
        console.error(`   ✗ Tool error: ${String(error)}`);
        result = { error: String(error) };
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  console.log("\n" + dim("─".repeat(60)));
  console.log(dim("Agent run complete."));
}

async function runDirectDemo(
  tronWeb: InstanceType<typeof TronWeb>,
  usdtContract: string,
  task: string
): Promise<void> {
  console.log(bold("\n🤖 AI Agent starting"));
  console.log("   Provider: Direct demo mode (no LLM credits required)");
  console.log(`   Payer   : ${tronWeb.defaultAddress.base58}`);
  console.log(`   Task    : ${task}\n`);

  console.log(dim("  [demo] Purchasing premium quote..."));
  const premiumResult = await purchaseData("/v1/agent/premium-quote", tronWeb, usdtContract);
  console.log(dim("  [demo] Purchasing market depth..."));
  const depthResult = await purchaseData("/v1/agent/market-depth", tronWeb, usdtContract);

  const premium = extractData<QuotePayload>(premiumResult);
  const depth = extractData<DepthPayload>(depthResult);

  const bid = premium?.quote?.bid;
  const ask = premium?.quote?.ask;
  const spread = premium?.quote?.spread;
  const spreadBps = premium?.quote?.spreadBps;
  const topBid = depth?.depth?.bids?.[0];
  const topAsk = depth?.depth?.asks?.[0];
  const totalBidSize = sumLevels(depth?.depth?.bids);
  const totalAskSize = sumLevels(depth?.depth?.asks);
  const imbalance =
    totalBidSize + totalAskSize > 0
      ? ((totalBidSize - totalAskSize) / (totalBidSize + totalAskSize)) * 100
      : 0;

  let advice =
    "Liquidity looks balanced enough for a small trader, but use limit orders and avoid chasing short-term moves.";

  if (typeof spreadBps === "number" && spreadBps > 8) {
    advice =
      "The spread is a bit wide for a small trader right now. Prefer patience and limit orders instead of crossing the spread.";
  } else if (imbalance > 10) {
    advice =
      "Bid depth is stronger than ask depth, which suggests short-term buying support. A small trader could scale in carefully with limit orders.";
  } else if (imbalance < -10) {
    advice =
      "Ask depth outweighs bid depth, so sellers currently have more size showing. A small trader should stay cautious and avoid aggressive entries.";
  }

  console.log(cyan("\n🤖 Direct market summary"));
  console.log(`   Best bid       : ${formatPrice(bid)}`);
  console.log(`   Best ask       : ${formatPrice(ask)}`);
  console.log(`   Spread         : ${typeof spread === "number" ? spread.toFixed(6) : "n/a"} (${typeof spreadBps === "number" ? spreadBps.toFixed(2) : "n/a"} bps)`);
  console.log(`   Top bid level  : ${topBid ? `${formatPrice(topBid.px)} x ${formatQty(topBid.sz)} TRX` : "n/a"}`);
  console.log(`   Top ask level  : ${topAsk ? `${formatPrice(topAsk.px)} x ${formatQty(topAsk.sz)} TRX` : "n/a"}`);
  console.log(`   Top-5 bid size : ${totalBidSize.toFixed(0)} TRX`);
  console.log(`   Top-5 ask size : ${totalAskSize.toFixed(0)} TRX`);
  console.log(`   Imbalance      : ${imbalance.toFixed(2)}%`);
  console.log(`   Advice         : ${advice}`);
  console.log(
    `   Settlement txs : ${premium?.settlementTx ?? "n/a"}, ${depth?.settlementTx ?? "n/a"}`
  );

  console.log("\n" + dim("─".repeat(60)));
  console.log(dim("Direct demo complete."));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!PAYER_KEY || PAYER_KEY.length < 64) {
    console.error(
      "NILE_PAYER_PRIVATE_KEY is not set. Add your Nile payer hex key to .env:\n  NILE_PAYER_PRIVATE_KEY=<64 hex chars>"
    );
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const tronWeb = new TronWeb({ fullHost: FULL_HOST, privateKey: PAYER_KEY });

  const usdtContract =
    process.env.TRON_NILE_USDT_CONTRACT ?? "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

  if (!["auto", "anthropic", "openai", "demo"].includes(AI_PROVIDER)) {
    console.error(
      "AI_PROVIDER must be one of: auto, anthropic, openai, demo"
    );
    process.exit(1);
  }

  if (AI_PROVIDER === "anthropic") {
    if (!ANTHROPIC_API_KEY) {
      console.error(
        "ANTHROPIC_API_KEY is not set. Add it to .env:\n  ANTHROPIC_API_KEY=sk-ant-..."
      );
      process.exit(1);
    }

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    await runAgent(anthropic, tronWeb, usdtContract, TASK);
    return;
  }

  if (AI_PROVIDER === "openai") {
    if (!OPENAI_API_KEY) {
      console.error(
        "OPENAI_API_KEY is not set. Add it to .env:\n  OPENAI_API_KEY=sk-..."
      );
      process.exit(1);
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    await runOpenAIAgent(openai, tronWeb, usdtContract, TASK);
    return;
  }

  if (AI_PROVIDER === "demo") {
    await runDirectDemo(tronWeb, usdtContract, TASK);
    return;
  }

  if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY) {
    console.error(
      "Set at least one LLM API key in .env:\n  ANTHROPIC_API_KEY=sk-ant-...\n  OPENAI_API_KEY=sk-..."
    );
    process.exit(1);
  }

  if (ANTHROPIC_API_KEY) {
    try {
      const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      await runAgent(anthropic, tronWeb, usdtContract, TASK);
      return;
    } catch (error) {
      if (OPENAI_API_KEY && hasLowCreditAnthropicError(error)) {
        console.warn(yellow("\nAnthropic credits unavailable. Falling back to OpenAI.\n"));
      } else if (hasLowCreditAnthropicError(error)) {
        console.warn(yellow("\nAnthropic credits unavailable. Falling back to direct demo mode.\n"));
        await runDirectDemo(tronWeb, usdtContract, TASK);
        return;
      } else {
        throw error;
      }
    }
  }

  if (!OPENAI_API_KEY) {
    console.error(
      "Anthropic fallback failed and OPENAI_API_KEY is not set. Add it to .env:\n  OPENAI_API_KEY=sk-..."
    );
    process.exit(1);
  }

  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    await runOpenAIAgent(openai, tronWeb, usdtContract, TASK);
  } catch (error) {
    if (hasOpenAIQuotaError(error)) {
      console.warn(yellow("\nOpenAI quota unavailable. Falling back to direct demo mode.\n"));
      await runDirectDemo(tronWeb, usdtContract, TASK);
      return;
    }
    throw error;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
