/**
 * Fully autonomous "agent": GET 402 → sign + broadcast payment on Nile → retry with proof.
 *
 * Uses a **payer private key** from env (TronLink not involved). For hackathon / demo only.
 * Never commit real keys. Never use mainnet keys here.
 *
 * Usage (API server must be running):
 *   npx tsx scripts/autonomous-agent.ts
 *   RESOURCE_PATH=/v1/agent/market-depth API_BASE=http://127.0.0.1:3001 npx tsx scripts/autonomous-agent.ts
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TronWebModule from "tronweb";

const { TronWeb } = TronWebModule;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:3001";
const RESOURCE_PATH = process.env.RESOURCE_PATH ?? "/v1/agent/premium-quote";
const FULL_HOST = process.env.TRON_FULL_HOST ?? "https://nile.trongrid.io";
const PAYMENT_VERIFY_MAX_RETRIES = Number(process.env.PAYMENT_VERIFY_MAX_RETRIES ?? "18");
const PAYMENT_VERIFY_DELAY_MS = Number(process.env.PAYMENT_VERIFY_DELAY_MS ?? "5000");
const EXPECTED_PAYMENT_SCHEME = process.env.EXPECTED_PAYMENT_SCHEME ?? "tron-settlement";
const EXPECTED_SETTLEMENT_NETWORK = process.env.EXPECTED_SETTLEMENT_NETWORK ?? "tron-nile";
const EXPECTED_MERCHANT_ADDRESS = process.env.MERCHANT_TRON_ADDRESS?.trim() ?? "";
const AGENT_MAX_USDT_UNITS = BigInt(process.env.AGENT_MAX_USDT_UNITS ?? "2000000");
const AGENT_MAX_TRX_SUN = BigInt(process.env.AGENT_MAX_TRX_SUN ?? "2000000");
/** Hex private key for the **payer** Nile account (no 0x prefix). Demo only. */
const PAYER_KEY = process.env.NILE_PAYER_PRIVATE_KEY?.trim();

type PaymentRequired = {
  x402Version?: number;
  scheme?: string;
  network?: string;
  resource?: string;
  nonce: string;
  amount: string;
  amountAsset: "TRX" | "USDT";
  recipient: string;
};

type Error402 = {
  paymentRequired?: PaymentRequired;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

function validatePaymentRequest(pr: PaymentRequired, resourcePath: string): void {
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
  if (pr.resource !== resourcePath) {
    throw new Error(
      `Refusing payment: resource mismatch. expected ${resourcePath}, got ${String(pr.resource)}`
    );
  }
  if (EXPECTED_MERCHANT_ADDRESS && pr.recipient !== EXPECTED_MERCHANT_ADDRESS) {
    throw new Error(
      `Refusing payment: recipient mismatch. expected ${EXPECTED_MERCHANT_ADDRESS}, got ${pr.recipient}`
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
}

async function main(): Promise<void> {
  if (!PAYER_KEY || PAYER_KEY.length < 64) {
    console.error(
      "Set NILE_PAYER_PRIVATE_KEY in .env (64 hex chars, Nile payer account — demo only, never commit)."
    );
    process.exit(1);
  }

  const tronWeb = new TronWeb({
    fullHost: FULL_HOST,
    privateKey: PAYER_KEY,
  });

  const from = tronWeb.defaultAddress.base58;
  if (!from) {
    console.error("Payer wallet has no default TRON address loaded.");
    process.exit(1);
  }
  console.log(`Payer address: ${from}`);

  const idem = `auto-${Date.now()}`;
  const r402 = await fetch(`${API_BASE}${RESOURCE_PATH}`, {
    headers: { "Idempotency-Key": idem },
  });
  const body402 = (await r402.json()) as Error402 & { error?: string; message?: string };

  if (r402.status !== 402 || !body402.paymentRequired) {
    console.error("Expected HTTP 402 with paymentRequired, got:", r402.status, body402);
    process.exit(1);
  }

  const pr = body402.paymentRequired;
  validatePaymentRequest(pr, RESOURCE_PATH);
  console.log("402 received:", pr.amountAsset, pr.amount, "→", pr.recipient);
  console.log(`nonce=${pr.nonce}`);

  let txid: string;

  if (pr.amountAsset === "TRX") {
    const amountSun = Number(pr.amount);
    const tx = await tronWeb.transactionBuilder.sendTrx(pr.recipient, amountSun, from);
    const signed = await tronWeb.trx.sign(tx);
    const sent = await tronWeb.trx.sendRawTransaction(signed);
    txid = extractTxid(sent);
    if (!txid) {
      console.error("Broadcast failed:", sent);
      process.exit(1);
    }
  } else {
    const contractAddr =
      process.env.TRON_NILE_USDT_CONTRACT ??
      "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
    const inst = await tronWeb.contract().at(contractAddr);
    const sent = await inst.transfer(pr.recipient, pr.amount).send({
      feeLimit: 150_000_000,
    });
    txid = extractTxid(sent);
    if (!txid) {
      console.error("USDT broadcast failed:", sent);
      process.exit(1);
    }
  }

  console.log(`Broadcast ok, txid=${txid}`);

  const maxRetries = Math.max(1, PAYMENT_VERIFY_MAX_RETRIES);
  const delayMs = Math.max(1000, PAYMENT_VERIFY_DELAY_MS);
  let finalStatus = 0;
  let finalBody: unknown = {};

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`Waiting ${delayMs}ms before attempt ${attempt}/${maxRetries}...`);
    await sleep(delayMs);

    const r = await fetch(`${API_BASE}${RESOURCE_PATH}`, {
      headers: {
        "X-Payment-Nonce": pr.nonce,
        "X-Payment-Tx-Id": txid,
        "Idempotency-Key": idem,
      },
    });
    finalBody = await r.json().catch(() => ({}));
    finalStatus = r.status;

    if (r.status === 200) break;

    const b = finalBody as { error?: string };
    if (r.status === 409) {
      // Already settled (idempotent success)
      console.log("409 — transaction already settled (idempotent).");
      break;
    }
    if (r.status === 402 && b.error === "payment_verification_failed") {
      // Tx not yet confirmed on-chain, retry
      console.log(`Attempt ${attempt}: payment not yet confirmed, retrying...`);
      continue;
    }
    // Any other error is not retryable
    console.error(`Non-retryable error (HTTP ${r.status}):`, finalBody);
    process.exit(1);
  }

  console.log(`HTTP ${finalStatus}`);
  console.log(JSON.stringify(finalBody, null, 2));

  if (finalStatus !== 200 && finalStatus !== 409) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
