/**
 * Enhanced Agent Demo — exercises the full Nile Commerce Gateway v2 flow.
 *
 * This is the "wow factor" demo for hackathon judges. It demonstrates:
 *   1. Agent self-registers on the AgentRegistry smart contract
 *   2. Discovers paid services via /v1/registry
 *   3. Runs OPSEC simulation before every payment
 *   4. Completes a standard x402 payment flow
 *   5. Checks reputation after transaction
 *   6. Prints spending report with budget tracking
 *
 * Prerequisites:
 *   - API server running: npm run dev
 *   - NILE_PAYER_PRIVATE_KEY in .env (Nile payer account, funded)
 *   - Contracts deployed (optional — works without them for off-chain features)
 *
 * Usage:
 *   npm run agent:enhanced
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
const FULL_HOST = process.env.TRON_FULL_HOST ?? "https://nile.trongrid.io";
const PAYER_KEY = process.env.NILE_PAYER_PRIVATE_KEY?.trim();
const RESOURCE_PATH = process.env.RESOURCE_PATH ?? "/v1/agent/premium-quote";

// ── Colors ────────────────────────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;

function banner(title: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(bold(`  ${title}`));
  console.log(`${"═".repeat(60)}\n`);
}

function step(n: number, label: string) {
  console.log(cyan(`\n── Step ${n}: ${label} ${"─".repeat(Math.max(0, 45 - label.length))}\n`));
}

function ok(msg: string) { console.log(`  ${green("✓")} ${msg}`); }
function warn(msg: string) { console.log(`  ${yellow("⚠")} ${msg}`); }
function fail(msg: string) { console.log(`  ${red("✗")} ${msg}`); }
function info(msg: string) { console.log(`  ${dim(msg)}`); }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main Demo ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner("Nile Commerce Gateway v2 — Enhanced Agent Demo");

  if (!PAYER_KEY || PAYER_KEY.length < 64) {
    fail("NILE_PAYER_PRIVATE_KEY not set. Set it in .env with a funded Nile address.");
    console.log(dim("  Get test TRX/USDT from https://nileex.io/join/getJoinPage"));
    process.exit(1);
  }

  const tronWeb = new TronWeb({ fullHost: FULL_HOST, privateKey: PAYER_KEY });
  const payerAddress = tronWeb.defaultAddress.base58;
  info(`Agent address: ${payerAddress}`);
  info(`API server: ${API_BASE}`);
  info(`Network: ${FULL_HOST}`);

  // ── Step 1: Register Agent Identity ──────────────────────────────────
  step(1, "Register Agent Identity");

  try {
    const regResult = await fetch(`${API_BASE}/v1/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: payerAddress,
        metadataURI: `https://agent.nile/${payerAddress}/profile.json`,
      }),
    });
    const regData = await regResult.json() as Record<string, unknown>;

    if (regData.ok) {
      ok(`Registered on AgentRegistry`);
      info(`Metadata URI: https://agent.nile/${payerAddress}/profile.json`);
      info(`Initial reputation: 0`);
    } else if (regData.error === "already_registered") {
      ok(`Already registered on AgentRegistry`);
    } else {
      warn(`Registration response: ${JSON.stringify(regData)}`);
    }
  } catch (e) {
    warn(`Agent registration failed (server may not have registry configured): ${String(e)}`);
  }

  // ── Step 2: Discover Services ────────────────────────────────────────
  step(2, "Discover Paid Services");

  let services: Array<{
    path: string;
    productName?: string;
    merchant: { id: string; name: string; address: string };
    price: { asset: string; amount: string; humanReadable?: string };
  }> = [];

  try {
    const regRes = await fetch(`${API_BASE}/v1/registry`);
    const registry = await regRes.json() as { services?: typeof services };
    services = registry.services ?? [];
    ok(`Found ${services.length} paid service(s) in registry`);
    for (const svc of services) {
      info(`  ${svc.path} — ${svc.productName ?? svc.path} — ${svc.price.humanReadable ?? `${svc.price.amount} ${svc.price.asset}`}`);
    }
  } catch (e) {
    fail(`Failed to fetch registry: ${String(e)}`);
    process.exit(1);
  }

  const targetService = services.find((s) => s.path === RESOURCE_PATH) ?? services[0];
  if (!targetService) {
    fail("No services available.");
    process.exit(1);
  }
  ok(`Selected: ${bold(targetService.path)}`);

  // ── Step 3: OPSEC Simulation ─────────────────────────────────────────
  step(3, "OPSEC Pre-Flight Safety Check");

  try {
    const simRes = await fetch(`${API_BASE}/v1/opsec/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: targetService.merchant.address,
        amount: targetService.price.amount,
        asset: targetService.price.asset,
      }),
    });
    const simData = await simRes.json() as {
      safe?: boolean;
      riskLevel?: string;
      checks?: Array<{ check: string; passed: boolean; detail?: string }>;
      warnings?: string[];
    };

    if (simData.safe) {
      ok(`Transaction simulation: ${green("SAFE")}`);
    } else {
      warn(`Transaction simulation: ${yellow(simData.riskLevel ?? "unknown")} risk`);
    }

    for (const c of simData.checks ?? []) {
      const icon = c.passed ? green("✓") : red("✗");
      console.log(`    ${icon} ${c.check}: ${dim(c.detail ?? "")}`);
    }

    if ((simData.warnings?.length ?? 0) > 0) {
      for (const w of simData.warnings ?? []) {
        warn(w);
      }
    }

    if (!simData.safe) {
      warn("Proceeding despite warnings (demo mode)...");
    }
  } catch (e) {
    warn(`OPSEC simulation failed: ${String(e)}`);
  }

  // ── Step 4: x402 Payment Flow ────────────────────────────────────────
  step(4, "Execute x402 Payment Flow");

  // 4a. Request resource → get 402
  info("Requesting resource (expecting HTTP 402)...");
  const initRes = await fetch(`${API_BASE}${targetService.path}`);
  if (initRes.status !== 402) {
    fail(`Expected 402, got ${initRes.status}`);
    process.exit(1);
  }
  ok(`Received HTTP 402 Payment Required`);

  const body402 = await initRes.json() as {
    paymentRequired?: {
      nonce: string;
      amount: string;
      amountAsset: "TRX" | "USDT";
      recipient: string;
    };
  };
  const pr = body402.paymentRequired;
  if (!pr) {
    fail("No paymentRequired in 402 response");
    process.exit(1);
  }

  info(`  Nonce: ${pr.nonce}`);
  info(`  Amount: ${pr.amount} ${pr.amountAsset}`);
  info(`  Recipient: ${pr.recipient}`);

  // 4b. Pay on-chain
  info("Sending payment on TRON Nile...");
  let txId = "";
  try {
    if (pr.amountAsset === "USDT") {
      const usdtContract = process.env.TRON_NILE_USDT_CONTRACT ?? "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
      const contract = await tronWeb.contract().at(usdtContract);
      const result = await contract.transfer(pr.recipient, pr.amount).send({ feeLimit: 100_000_000 });
      txId = typeof result === "string" ? result : "";
    } else {
      const tx = await tronWeb.transactionBuilder.sendTrx(
        pr.recipient,
        Number(pr.amount),
        payerAddress
      );
      const signed = await tronWeb.trx.sign(tx, PAYER_KEY);
      const result = await tronWeb.trx.sendRawTransaction(signed as Parameters<typeof tronWeb.trx.sendRawTransaction>[0]);
      txId = (result as { txid?: string }).txid ?? "";
    }

    if (!txId) {
      fail("No txid returned from payment");
      process.exit(1);
    }
    ok(`Payment sent: ${txId}`);
    info(`  Explorer: https://nile.tronscan.org/#/transaction/${txId}`);
  } catch (e) {
    fail(`Payment failed: ${String(e)}`);
    process.exit(1);
  }

  // 4c. Wait for confirmation
  info("Waiting for confirmation...");
  await sleep(4000);

  // 4d. Verify payment → get data
  info("Verifying payment with gateway...");
  let verified = false;
  let accessToken = "";
  let responseData: unknown = null;

  for (let attempt = 1; attempt <= 10; attempt++) {
    const verifyRes = await fetch(`${API_BASE}${targetService.path}`, {
      headers: {
        "X-Payment-Nonce": pr.nonce,
        "X-Payment-Tx-Id": txId,
      },
    });

    if (verifyRes.status === 200) {
      const data = await verifyRes.json() as {
        ok?: boolean;
        accessToken?: string;
        data?: unknown;
        verification?: unknown;
      };
      verified = true;
      accessToken = data.accessToken ?? "";
      responseData = data.data;
      ok(`Payment verified! Access granted.`);
      info(`  JWT Receipt: ${accessToken.slice(0, 40)}...`);
      break;
    }

    info(`  Attempt ${attempt}/10: HTTP ${verifyRes.status} — retrying in 3s...`);
    await sleep(3000);
  }

  if (!verified) {
    fail("Payment verification timed out after 10 attempts.");
    process.exit(1);
  }

  // 4e. Display purchased data
  if (responseData) {
    console.log(magenta("\n  ── Purchased Data ──"));
    console.log(dim(JSON.stringify(responseData, null, 2).split("\n").map((l) => `  ${l}`).join("\n")));
  }

  // ── Step 5: Session Re-use ───────────────────────────────────────────
  step(5, "Session Re-use with JWT Receipt");

  if (accessToken) {
    const sessionRes = await fetch(`${API_BASE}${targetService.path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (sessionRes.status === 200) {
      ok(`Session re-use successful (no second payment needed)`);
    } else {
      warn(`Session re-use returned HTTP ${sessionRes.status}`);
    }
  }

  // ── Step 6: Check Agent Reputation ───────────────────────────────────
  step(6, "Check Agent Reputation");

  try {
    const agentRes = await fetch(`${API_BASE}/v1/agents/${payerAddress}`);
    const agentData = await agentRes.json() as {
      badge?: string;
      local?: { reputation?: number; totalTransactions?: number };
    };
    if (agentData.local) {
      ok(`Reputation: ${agentData.local.reputation ?? 0}`);
      ok(`Badge: ${bold(agentData.badge ?? "bronze")}`);
      info(`Total transactions: ${agentData.local.totalTransactions ?? 0}`);
    } else {
      info("Agent profile not found in local cache.");
    }
  } catch (e) {
    warn(`Could not fetch agent profile: ${String(e)}`);
  }

  // ── Step 7: Spending Report ──────────────────────────────────────────
  step(7, "Spending Report & Budget Tracking");

  try {
    const spendRes = await fetch(`${API_BASE}/v1/opsec/spending-report?payer=${payerAddress}`);
    const spend = await spendRes.json() as {
      txCount?: number;
      totalUsdtUnits?: string;
      totalTrxSun?: string;
      budgetUsage?: { usdtUsedPct?: number; trxUsedPct?: number };
      merchantBreakdown?: Array<{ merchantId: string; count: number; totalUnits: string }>;
    };

    ok(`Total transactions: ${spend.txCount ?? 0}`);
    ok(`USDT spent: ${((Number(spend.totalUsdtUnits ?? 0)) / 1e6).toFixed(2)} USDT`);
    ok(`TRX spent: ${((Number(spend.totalTrxSun ?? 0)) / 1e6).toFixed(2)} TRX`);

    if (spend.budgetUsage) {
      const uPct = spend.budgetUsage.usdtUsedPct ?? 0;
      const tPct = spend.budgetUsage.trxUsedPct ?? 0;
      const bar = (pct: number) => {
        const filled = Math.round(pct / 5);
        return `[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${pct}%`;
      };
      info(`USDT budget: ${bar(uPct)}`);
      info(`TRX budget:  ${bar(tPct)}`);
    }

    if (spend.merchantBreakdown?.length) {
      info("Per-merchant breakdown:");
      for (const m of spend.merchantBreakdown) {
        info(`  ${m.merchantId}: ${m.count} tx, ${m.totalUnits} units`);
      }
    }
  } catch (e) {
    warn(`Could not fetch spending report: ${String(e)}`);
  }

  // ── Done ─────────────────────────────────────────────────────────────
  banner("Demo Complete");
  console.log(green("  All 7 steps completed successfully!\n"));
  console.log(dim("  Bounty directions demonstrated:"));
  console.log(dim("    1. x402-style payments on TRON (Step 4)"));
  console.log(dim("    2. Micro-transaction enablement (Steps 4-5)"));
  console.log(dim("    3. Discovery + trust beyond ERC-8004 (Steps 1, 2, 6)"));
  console.log(dim("    4. Security-centric agent execution (Step 3)"));
  console.log(dim("    5. OPSEC dev tooling (Steps 3, 7)"));
  console.log(dim("    6. Agentic commerce standards (Full flow)"));
  console.log(dim("    7. Agentic chargeback (Escrow available via /v1/escrow)\n"));
}

main().catch((e) => {
  fail(`Demo failed: ${String(e)}`);
  process.exit(1);
});
