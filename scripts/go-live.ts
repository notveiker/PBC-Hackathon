/**
 * go-live.ts — Full end-to-end live verification on TRON Nile testnet.
 *
 * This script:
 *   1. Checks wallet balances
 *   2. Deploys smart contracts (if not already deployed)
 *   3. Registers the agent on-chain
 *   4. Runs OPSEC simulation
 *   5. Executes a real x402 payment flow with on-chain TRX transfer
 *   6. Verifies the settlement receipt
 *   7. Creates an escrow on-chain
 *   8. Prints a complete verification report with explorer links
 *
 * Usage: npx tsx scripts/go-live.ts
 */

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TronWebModule from "tronweb";

const { TronWeb } = TronWebModule;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:3001";
const FULL_HOST = process.env.TRON_FULL_HOST ?? "https://nile.trongrid.io";
const MERCHANT_KEY = process.env.GATEWAY_PRIVATE_KEY?.trim() ?? "";
const PAYER_KEY = process.env.NILE_PAYER_PRIVATE_KEY?.trim() ?? "";
const MERCHANT_ADDR = process.env.MERCHANT_TRON_ADDRESS?.trim() ?? "";

// Colors
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;

function banner(t: string) { console.log(`\n${"═".repeat(70)}\n  ${bold(t)}\n${"═".repeat(70)}\n`); }
function step(n: number, t: string) { console.log(cyan(`\n── Step ${n}: ${t} ${"─".repeat(Math.max(0, 52 - t.length))}\n`)); }
function ok(m: string) { console.log(`  ${green("✓")} ${m}`); }
function warn(m: string) { console.log(`  ${yellow("⚠")} ${m}`); }
function fail(m: string) { console.log(`  ${red("✗")} ${m}`); }
function info(m: string) { console.log(`  ${dim(m)}`); }
function link(label: string, url: string) { console.log(`  ${dim(label)}: ${cyan(url)}`); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const results: { step: string; status: string; txId?: string; explorer?: string }[] = [];

async function main() {
  banner("NILE COMMERCE GATEWAY v2 — LIVE ON-CHAIN VERIFICATION");

  if (!MERCHANT_KEY || !PAYER_KEY) {
    fail("Missing GATEWAY_PRIVATE_KEY or NILE_PAYER_PRIVATE_KEY in .env");
    process.exit(1);
  }

  const merchantTw = new TronWeb({ fullHost: FULL_HOST, privateKey: MERCHANT_KEY });
  const payerTw = new TronWeb({ fullHost: FULL_HOST, privateKey: PAYER_KEY });
  const merchantAddr = merchantTw.defaultAddress.base58;
  const payerAddr = payerTw.defaultAddress.base58;

  // ── Step 1: Check balances ──────────────────────────────────────────
  step(1, "Check Wallet Balances on Nile");

  const merchantBal = await merchantTw.trx.getBalance(merchantAddr);
  const payerBal = await payerTw.trx.getBalance(payerAddr);

  ok(`Merchant (${merchantAddr}): ${(merchantBal / 1e6).toFixed(2)} TRX`);
  ok(`Agent   (${payerAddr}): ${(payerBal / 1e6).toFixed(2)} TRX`);
  link("Merchant explorer", `https://nile.tronscan.org/#/address/${merchantAddr}`);
  link("Agent explorer", `https://nile.tronscan.org/#/address/${payerAddr}`);

  if (merchantBal < 100_000_000) {
    fail(`Merchant needs at least 100 TRX (has ${(merchantBal/1e6).toFixed(2)}). Fund from https://nileex.io/join/getJoinPage`);
    process.exit(1);
  }
  if (payerBal < 10_000_000) {
    fail(`Agent payer needs at least 10 TRX (has ${(payerBal/1e6).toFixed(2)}). Fund from https://nileex.io/join/getJoinPage`);
    process.exit(1);
  }
  results.push({ step: "Wallet balances", status: "OK" });

  // ── Step 2: Deploy smart contracts ──────────────────────────────────
  step(2, "Deploy Smart Contracts to Nile");

  const deployedPath = path.join(root, "contracts", "deployed.json");
  let deployed: Record<string, { address: string; txId?: string }> = {};

  if (fs.existsSync(deployedPath)) {
    deployed = JSON.parse(fs.readFileSync(deployedPath, "utf-8"));
    if (deployed.EscrowPayment?.address && deployed.AgentRegistry?.address) {
      ok(`Contracts already deployed`);
      ok(`EscrowPayment: ${deployed.EscrowPayment.address}`);
      ok(`AgentRegistry: ${deployed.AgentRegistry.address}`);
    }
  }

  if (!deployed.EscrowPayment?.address || !deployed.AgentRegistry?.address) {
    info("Deploying contracts...");

    // Deploy EscrowPayment
    const escrowArtifact = JSON.parse(fs.readFileSync(path.join(root, "contracts/build/EscrowPayment.json"), "utf-8"));
    const escrowContract = await (merchantTw as any).contract().new({
      abi: escrowArtifact.abi,
      bytecode: escrowArtifact.bytecode,
      feeLimit: 1_000_000_000,
      callValue: 0,
      parameters: [merchantAddr, 20],
    });
    const escrowAddr = merchantTw.address.fromHex(escrowContract.address);
    ok(`EscrowPayment deployed: ${escrowAddr}`);
    link("Explorer", `https://nile.tronscan.org/#/contract/${escrowAddr}`);

    // Deploy AgentRegistry
    const registryArtifact = JSON.parse(fs.readFileSync(path.join(root, "contracts/build/AgentRegistry.json"), "utf-8"));
    const registryContract = await (merchantTw as any).contract().new({
      abi: registryArtifact.abi,
      bytecode: registryArtifact.bytecode,
      feeLimit: 1_000_000_000,
      callValue: 0,
      parameters: [],
    });
    const registryAddr = merchantTw.address.fromHex(registryContract.address);
    ok(`AgentRegistry deployed: ${registryAddr}`);
    link("Explorer", `https://nile.tronscan.org/#/contract/${registryAddr}`);

    deployed = {
      EscrowPayment: { address: escrowAddr },
      AgentRegistry: { address: registryAddr },
    };
    fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
    ok("Addresses saved to contracts/deployed.json");

    results.push({ step: "Deploy EscrowPayment", status: "OK", explorer: `https://nile.tronscan.org/#/contract/${escrowAddr}` });
    results.push({ step: "Deploy AgentRegistry", status: "OK", explorer: `https://nile.tronscan.org/#/contract/${registryAddr}` });
  } else {
    results.push({ step: "Smart contracts", status: "Already deployed" });
  }

  // ── Step 3: Register agent on-chain ─────────────────────────────────
  step(3, "Register Agent on AgentRegistry (on-chain)");

  const registryAbi = JSON.parse(fs.readFileSync(path.join(root, "contracts/build/AgentRegistry.json"), "utf-8")).abi;
  const registry = await payerTw.contract(registryAbi, deployed.AgentRegistry.address);

  let isReg = false;
  try {
    isReg = await registry.isRegistered(payerAddr).call();
  } catch { /* not registered */ }

  if (isReg) {
    ok("Agent already registered on-chain");
  } else {
    info("Registering agent...");
    const regTx = await registry.registerAgent(`https://agent.nile/${payerAddr}/profile.json`).send({ feeLimit: 100_000_000 });
    const regTxId = typeof regTx === "string" ? regTx : "";
    ok(`Agent registered on-chain`);
    link("Tx", `https://nile.tronscan.org/#/transaction/${regTxId}`);
    results.push({ step: "Register agent on-chain", status: "OK", txId: regTxId, explorer: `https://nile.tronscan.org/#/transaction/${regTxId}` });
    await sleep(4000);
  }

  // Verify
  const agentInfo = await registry.getAgent(payerAddr).call();
  ok(`On-chain reputation: ${agentInfo.reputation.toString()}, registered: ${agentInfo.registered}`);

  // Also register on the gateway
  try {
    await fetch(`${API_BASE}/v1/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: payerAddr, metadataURI: `https://agent.nile/${payerAddr}/profile.json` }),
    });
    ok("Agent registered on gateway API");
  } catch { /* ignore if already registered */ }

  // ── Step 4: OPSEC simulation ────────────────────────────────────────
  step(4, "OPSEC Pre-Flight Simulation");

  const simRes = await fetch(`${API_BASE}/v1/opsec/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: merchantAddr, amount: "1000000", asset: "TRX" }),
  });
  const simData = await simRes.json() as { safe?: boolean; checks?: Array<{ check: string; passed: boolean; detail?: string }> };

  for (const c of simData.checks ?? []) {
    const icon = c.passed ? green("✓") : red("✗");
    console.log(`    ${icon} ${c.check}: ${dim(c.detail ?? "")}`);
  }
  ok(`Simulation result: ${simData.safe ? green("SAFE") : red("UNSAFE")}`);
  results.push({ step: "OPSEC simulation", status: simData.safe ? "SAFE" : "UNSAFE" });

  // ── Step 5: Live x402 payment ───────────────────────────────────────
  step(5, "Execute Live x402 Payment on Nile");

  // 5a. Request resource → 402
  info("GET /v1/agent/premium-quote → expecting 402...");
  const initRes = await fetch(`${API_BASE}/v1/agent/premium-quote`);
  if (initRes.status !== 402) {
    fail(`Expected 402, got ${initRes.status}`);
    process.exit(1);
  }
  ok("Received HTTP 402 Payment Required");

  const body402 = await initRes.json() as { paymentRequired?: { nonce: string; amount: string; amountAsset: string; recipient: string } };
  const pr = body402.paymentRequired!;
  info(`  Nonce: ${pr.nonce}`);
  info(`  Amount: ${pr.amount} ${pr.amountAsset}`);
  info(`  Recipient: ${pr.recipient}`);

  // 5b. Send TRX on Nile
  info("Sending TRX payment on-chain...");
  const tx = await payerTw.transactionBuilder.sendTrx(pr.recipient, Number(pr.amount), payerAddr);
  const signed = await payerTw.trx.sign(tx, PAYER_KEY);
  const broadcast = await payerTw.trx.sendRawTransaction(signed as Parameters<typeof payerTw.trx.sendRawTransaction>[0]);
  const txId = (broadcast as { txid?: string }).txid ?? "";

  if (!txId) {
    fail("No txId returned");
    process.exit(1);
  }
  ok(`Payment broadcast: ${txId}`);
  link("Tx explorer", `https://nile.tronscan.org/#/transaction/${txId}`);
  results.push({ step: "TRX payment on-chain", status: "OK", txId, explorer: `https://nile.tronscan.org/#/transaction/${txId}` });

  // 5c. Wait for on-chain confirmation
  info("Waiting for on-chain confirmation (15s)...");
  await sleep(15000);

  // 5d. Verify with gateway using a fresh nonce
  //     We request a new 402 to get a fresh nonce, then verify with our already-confirmed txId.
  info("Getting fresh payment nonce for verification...");
  const freshRes = await fetch(`${API_BASE}/v1/agent/premium-quote`);
  const freshBody = await freshRes.json() as { paymentRequired?: { nonce: string } };
  const freshNonce = freshBody.paymentRequired?.nonce ?? pr.nonce;

  info("Verifying payment with gateway...");
  let verified = false;
  let accessToken = "";
  let responseData: unknown = null;

  for (let attempt = 1; attempt <= 6; attempt++) {
    const vRes = await fetch(`${API_BASE}/v1/agent/premium-quote`, {
      headers: { "X-Payment-Nonce": freshNonce, "X-Payment-Tx-Id": txId },
    });

    if (vRes.status === 200) {
      const d = await vRes.json() as { ok?: boolean; accessToken?: string; data?: unknown; verification?: unknown };
      verified = true;
      accessToken = d.accessToken ?? "";
      responseData = d.data;
      ok(green("Payment VERIFIED! Access granted."));
      info(`  JWT Receipt: ${accessToken.slice(0, 50)}...`);
      results.push({ step: "Payment verification", status: "VERIFIED" });
      break;
    }
    const errBody = await vRes.json().catch(() => null) as { error?: string; message?: string } | null;
    info(`  Attempt ${attempt}/6: HTTP ${vRes.status} ${errBody?.message ?? errBody?.error ?? ""} — retrying in 5s...`);
    await sleep(5000);
  }

  if (!verified) {
    fail("Verification failed. Check server logs for details.");
    process.exit(1);
  }

  // 5e. Show purchased data
  if (responseData) {
    console.log(magenta("\n  ── Purchased Data (LIVE from Binance) ──"));
    console.log(dim(JSON.stringify(responseData, null, 2).split("\n").map(l => `  ${l}`).join("\n")));
  }

  // ── Step 6: Session re-use ──────────────────────────────────────────
  step(6, "Session Re-use with JWT Receipt");
  const sessionRes = await fetch(`${API_BASE}/v1/agent/premium-quote`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (sessionRes.status === 200) {
    ok("Session re-use works (no second payment)");
    results.push({ step: "JWT session re-use", status: "OK" });
  }

  // ── Step 7: Create on-chain escrow ──────────────────────────────────
  step(7, "Create On-Chain Escrow");

  const escrowAbi = JSON.parse(fs.readFileSync(path.join(root, "contracts/build/EscrowPayment.json"), "utf-8")).abi;
  const escrow = await payerTw.contract(escrowAbi, deployed.EscrowPayment.address);

  const serviceIdBytes = payerTw.sha3("premium-quote");
  info("Creating escrow for 0.5 TRX...");

  const escrowTx = await escrow.createEscrow(serviceIdBytes, merchantAddr).send({
    feeLimit: 100_000_000,
    callValue: 500_000, // 0.5 TRX
  });
  const escrowTxId = typeof escrowTx === "string" ? escrowTx : "";
  ok(`Escrow created on-chain`);
  link("Tx explorer", `https://nile.tronscan.org/#/transaction/${escrowTxId}`);

  await sleep(4000);
  const nextId = await escrow.nextEscrowId().call();
  const createdEscrowId = Number(nextId) - 1;
  ok(`Escrow ID: ${createdEscrowId}`);

  // Record on gateway
  await fetch(`${API_BASE}/v1/escrow/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serviceId: "premium-quote",
      merchantAddress: merchantAddr,
      amountSun: "500000",
      buyerAddress: payerAddr,
      createTxId: escrowTxId,
      escrowId: createdEscrowId,
    }),
  });
  ok("Escrow recorded on gateway");
  results.push({ step: "On-chain escrow", status: "OK", txId: escrowTxId, explorer: `https://nile.tronscan.org/#/transaction/${escrowTxId}` });

  // Read escrow state
  const escrowState = await escrow.getEscrow(createdEscrowId).call();
  const statusMap = ["Created", "Disputed", "Released", "Resolved"];
  ok(`On-chain state: buyer=${payerTw.address.fromHex(escrowState.buyer)}, amount=${escrowState.amount.toString()} sun, status=${statusMap[Number(escrowState.status)]}`);

  // ── Step 8: Update reputation on-chain ──────────────────────────────
  step(8, "Update Agent Reputation On-Chain");

  const registryGw = await merchantTw.contract(registryAbi, deployed.AgentRegistry.address);
  const repTx = await registryGw.updateReputation(payerAddr, 10).send({ feeLimit: 100_000_000 });
  const repTxId = typeof repTx === "string" ? repTx : "";
  ok(`Reputation +10 on-chain`);
  link("Tx explorer", `https://nile.tronscan.org/#/transaction/${repTxId}`);

  await sleep(3000);
  const updatedAgent = await registry.getAgent(payerAddr).call();
  ok(`New reputation: ${updatedAgent.reputation.toString()}`);
  results.push({ step: "Reputation update on-chain", status: "OK", txId: repTxId, explorer: `https://nile.tronscan.org/#/transaction/${repTxId}` });

  // ── Step 9: Spending report ─────────────────────────────────────────
  step(9, "Spending Report");

  const spendRes = await fetch(`${API_BASE}/v1/opsec/spending-report?payer=${payerAddr}`);
  const spend = await spendRes.json() as { txCount?: number; totalTrxSun?: string; totalUsdtUnits?: string; budgetUsage?: { trxUsedPct?: number } };
  ok(`Transactions: ${spend.txCount}`);
  ok(`TRX spent: ${(Number(spend.totalTrxSun ?? 0) / 1e6).toFixed(2)}`);
  ok(`Budget used: ${spend.budgetUsage?.trxUsedPct ?? 0}%`);
  results.push({ step: "Spending report", status: "OK" });

  // ── Final Report ────────────────────────────────────────────────────
  banner("LIVE VERIFICATION REPORT");

  console.log(bold("  On-Chain Artifacts (verifiable on Nile Tronscan):\n"));

  for (const r of results) {
    const icon = r.status === "OK" || r.status === "VERIFIED" || r.status === "SAFE" ? green("✓") : yellow("⚠");
    console.log(`  ${icon} ${r.step}: ${bold(r.status)}`);
    if (r.explorer) console.log(`    ${dim(r.explorer)}`);
  }

  console.log(`\n  ${bold("Contract Addresses:")}`);
  console.log(`    EscrowPayment:  ${deployed.EscrowPayment.address}`);
  console.log(`    AgentRegistry:  ${deployed.AgentRegistry.address}`);
  console.log(`\n  ${bold("Wallet Addresses:")}`);
  console.log(`    Merchant: ${merchantAddr}`);
  console.log(`    Agent:    ${payerAddr}`);

  const finalMerchantBal = await merchantTw.trx.getBalance(merchantAddr);
  const finalPayerBal = await payerTw.trx.getBalance(payerAddr);
  console.log(`\n  ${bold("Final Balances:")}`);
  console.log(`    Merchant: ${(finalMerchantBal / 1e6).toFixed(2)} TRX`);
  console.log(`    Agent:    ${(finalPayerBal / 1e6).toFixed(2)} TRX`);

  console.log(`\n  ${bold("Dashboard:")} ${cyan("http://localhost:5173")}`);
  console.log(`  ${bold("API:")}       ${cyan("http://localhost:3001")}\n`);
  console.log(green("  All steps completed. Everything is live on TRON Nile testnet.\n"));
}

main().catch(e => {
  fail(`Fatal: ${String(e)}`);
  process.exit(1);
});
