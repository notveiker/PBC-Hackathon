/**
 * OPSEC Dev Tooling — transaction simulation, contract analysis, spending reports.
 *
 * These endpoints help agents (and humans) validate transactions before signing,
 * detect risky contracts, and track spending. Covers the "OPSEC dev tooling"
 * bounty direction.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type Database from "better-sqlite3";
import { config } from "./config.js";
import { insertRiskEvent, spendingReport } from "./db.js";
import { listMerchants } from "./serviceCatalog.js";
import type { TronWebInstance } from "./tronVerify.js";

// ── Known addresses (Nile testnet) ─────────────────────────────────────────

/** Known safe USDT contract on Nile */
const KNOWN_TOKEN_CONTRACTS: Record<string, string> = {
  TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf: "USDT (Nile)",
};

/** Heuristic scam patterns */
const SCAM_INDICATORS = [
  "0000000000000000000000000000000000", // burn address pattern
];

// ── Schemas ────────────────────────────────────────────────────────────────

const SimulateSchema = z.object({
  to: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{25,40}$/),
  amount: z.string().regex(/^\d+$/),
  asset: z.enum(["TRX", "USDT"]),
  contractAddress: z.string().optional(),
});

const AnalyzeContractSchema = z.object({
  address: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{25,40}$/),
});

// ── Routes ─────────────────────────────────────────────────────────────────

export function registerOpsecRoutes(
  app: FastifyInstance,
  db: Database.Database,
  tronWeb: TronWebInstance
): void {
  /**
   * POST /v1/opsec/simulate — Dry-run transaction validation.
   * Checks recipient, amount caps, known merchants, scam patterns.
   */
  app.post("/v1/opsec/simulate", async (req, reply) => {
    const parsed = SimulateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.flatten() });
    }

    const { to, amount, asset } = parsed.data;
    const amountBig = BigInt(amount);
    const warnings: string[] = [];
    const checks: { check: string; passed: boolean; detail?: string }[] = [];

    // 1. Recipient known as merchant?
    const merchants = listMerchants();
    const knownMerchant = merchants.find((m) => m.address === to);
    checks.push({
      check: "recipient_known_merchant",
      passed: Boolean(knownMerchant),
      detail: knownMerchant
        ? `Known merchant: ${knownMerchant.name} (${knownMerchant.id})`
        : "Recipient is not a registered merchant",
    });
    if (!knownMerchant) {
      warnings.push("Recipient address is not a registered merchant in the service catalog.");
    }

    // 2. Amount within configured caps
    const maxUsdt = BigInt(process.env.AGENT_MAX_USDT_UNITS ?? "2000000");
    const maxTrx = BigInt(process.env.AGENT_MAX_TRX_SUN ?? "2000000");
    const cap = asset === "USDT" ? maxUsdt : maxTrx;
    const amountOk = amountBig <= cap;
    checks.push({
      check: "amount_within_cap",
      passed: amountOk,
      detail: amountOk
        ? `${amount} <= ${cap} ${asset === "USDT" ? "minimal units" : "sun"}`
        : `Amount ${amount} exceeds cap ${cap}`,
    });
    if (!amountOk) {
      warnings.push(`Amount ${amount} exceeds the configured spending cap of ${cap}.`);
    }

    // 3. Scam address check
    const isScam = SCAM_INDICATORS.some((pattern) => to.includes(pattern));
    checks.push({
      check: "not_scam_address",
      passed: !isScam,
      detail: isScam ? "Address matches known scam pattern" : "No scam patterns detected",
    });
    if (isScam) {
      warnings.push("Recipient address matches a known scam pattern!");
    }

    // 4. If USDT, check contract matches known USDT
    if (asset === "USDT") {
      const contractAddr = parsed.data.contractAddress ?? config.usdtContractAddress;
      const knownToken = KNOWN_TOKEN_CONTRACTS[contractAddr];
      checks.push({
        check: "known_token_contract",
        passed: Boolean(knownToken),
        detail: knownToken ? `Token: ${knownToken}` : `Unknown token contract: ${contractAddr}`,
      });
      if (!knownToken) {
        warnings.push(`USDT contract ${contractAddr} is not in the known tokens list.`);
      }
    }

    // 5. Check if address is an active account on-chain
    let accountActive = false;
    try {
      const account = await tronWeb.trx.getAccount(to);
      accountActive = Boolean((account as { address?: string }).address);
    } catch {
      // Not found
    }
    checks.push({
      check: "recipient_account_active",
      passed: accountActive,
      detail: accountActive ? "Account is active on Nile" : "Account not found or not activated",
    });
    if (!accountActive) {
      warnings.push("Recipient account is not activated on Nile testnet.");
    }

    const safe = warnings.length === 0;

    insertRiskEvent(db, {
      actor: "opsec",
      action: safe ? "allow" : "warn",
      severity: safe ? "low" : "medium",
      reason: "tx_simulation",
      details: { to, amount, asset, safe, warningCount: warnings.length },
    });

    return {
      safe,
      riskLevel: warnings.length === 0 ? "low" : warnings.length <= 2 ? "medium" : "high",
      checks,
      warnings,
      summary: safe
        ? "Transaction appears safe to execute."
        : `${warnings.length} warning(s) detected. Review before signing.`,
    };
  });

  /**
   * POST /v1/opsec/analyze-contract — Analyze a contract address for risk.
   */
  app.post("/v1/opsec/analyze-contract", async (req, reply) => {
    const parsed = AnalyzeContractSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.flatten() });
    }

    const { address } = parsed.data;
    const warnings: string[] = [];

    // Check if it's a contract
    let isContract = false;
    let hasCode = false;
    let contractName: string | undefined;

    try {
      const contractInfo = await tronWeb.trx.getContract(address);
      const info = contractInfo as {
        contract_address?: string;
        bytecode?: string;
        name?: string;
        abi?: { entrys?: unknown[] };
      };
      isContract = Boolean(info.contract_address || info.bytecode);
      hasCode = Boolean(info.bytecode && info.bytecode.length > 2);
      contractName = info.name;
    } catch {
      // Not a contract or not found
    }

    // Known token check
    const knownToken = KNOWN_TOKEN_CONTRACTS[address];

    // Risk assessment
    if (!isContract) {
      warnings.push("Address is not a smart contract (EOA or unactivated).");
    }
    if (isContract && !hasCode) {
      warnings.push("Contract has no bytecode — may be a proxy or self-destructed.");
    }
    if (isContract && !knownToken) {
      warnings.push("Contract is not in the known tokens/contracts list.");
    }

    const riskLevel = !isContract ? "low" : knownToken ? "low" : warnings.length > 1 ? "high" : "medium";

    insertRiskEvent(db, {
      actor: "opsec",
      action: "allow",
      severity: riskLevel,
      reason: "contract_analysis",
      details: { address, isContract, hasCode, knownToken: knownToken ?? null, riskLevel },
    });

    return {
      address,
      isContract,
      hasCode,
      knownToken: knownToken ?? null,
      contractName: contractName ?? null,
      riskLevel,
      warnings,
      explorerUrl: `https://nile.tronscan.org/#/contract/${address}`,
    };
  });

  /**
   * GET /v1/opsec/spending-report — Agent spending summary from settlement data.
   */
  app.get("/v1/opsec/spending-report", async (req) => {
    const q = req.query as { payer?: string; since?: string };
    const payer = q.payer?.trim() ?? "";
    const sinceHours = Math.min(168, Math.max(1, Number(q.since ?? 24)));
    const sinceMsAgo = sinceHours * 60 * 60 * 1000;

    if (!payer) {
      return {
        error: "payer_required",
        message: "Provide ?payer=T... to get spending report.",
      };
    }

    const report = spendingReport(db, payer, sinceMsAgo);

    // Calculate budget usage
    const maxUsdt = BigInt(process.env.AGENT_MAX_USDT_UNITS ?? "2000000");
    const maxTrx = BigInt(process.env.AGENT_MAX_TRX_SUN ?? "2000000");
    const usdtUsedPct = maxUsdt > 0n ? Number((BigInt(report.totalUsdtUnits) * 100n) / maxUsdt) : 0;
    const trxUsedPct = maxTrx > 0n ? Number((BigInt(report.totalTrxSun) * 100n) / maxTrx) : 0;

    return {
      ...report,
      period: `${sinceHours}h`,
      budgetUsage: {
        usdtUsedPct: Math.min(usdtUsedPct, 100),
        trxUsedPct: Math.min(trxUsedPct, 100),
        usdtCapUnits: maxUsdt.toString(),
        trxCapSun: maxTrx.toString(),
      },
      note: "Spending caps can be configured via AGENT_MAX_USDT_UNITS and AGENT_MAX_TRX_SUN env vars.",
    };
  });
}
