/**
 * Escrow Routes — On-chain escrow with dispute resolution for agentic commerce.
 *
 * Wraps the EscrowPayment smart contract, enriches with SQLite state,
 * and logs all actions to risk_events for audit.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, monorepoRoot, checkAdminAuth } from "./config.js";
import {
  insertEscrow,
  getEscrowByChainId,
  updateEscrowStatus,
  listEscrows,
  insertRiskEvent,
} from "./db.js";
import type { TronWebInstance } from "./tronVerify.js";

// ── Load contract ABI ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAbi = any;

function loadEscrowAbi(): AnyAbi[] {
  const buildPath = path.join(monorepoRoot, "contracts", "build", "EscrowPayment.json");
  if (!fs.existsSync(buildPath)) return [];
  const artifact = JSON.parse(fs.readFileSync(buildPath, "utf-8"));
  return artifact.abi ?? [];
}

// ── Schemas ───────────────────────────────────────────────────────────────

const CreateEscrowSchema = z.object({
  serviceId: z.string().min(1),
  merchantAddress: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{25,40}$/),
  amountSun: z.string().regex(/^\d+$/),
  buyerAddress: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{25,40}$/),
  createTxId: z.string().regex(/^[0-9a-fA-F]{64}$/),
  escrowId: z.number().int().nonnegative(),
});

const DisputeSchema = z.object({
  reason: z.string().min(3).max(500),
  disputeTxId: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
});

const ResolveSchema = z.object({
  buyerPct: z.number().int().min(0).max(100),
});

// ── Routes ────────────────────────────────────────────────────────────────

export function registerEscrowRoutes(
  app: FastifyInstance,
  db: Database.Database,
  tronWeb: TronWebInstance
): void {
  const escrowAddress = config.escrowContractAddress;

  /**
   * GET /v1/escrow/info — Contract address and ABI for frontend/agent to interact directly.
   */
  app.get("/v1/escrow/info", async () => {
    const abi = loadEscrowAbi();
    return {
      contractAddress: escrowAddress || null,
      abi: abi.length > 0 ? abi : null,
      network: "tron-nile",
      defaultLockBlocks: 20,
      explorerUrl: escrowAddress
        ? `https://nile.tronscan.org/#/contract/${escrowAddress}`
        : null,
      configured: Boolean(escrowAddress),
    };
  });

  /**
   * POST /v1/escrow/record — Record an escrow creation that happened on-chain.
   * The buyer/agent creates the escrow directly on the contract, then tells the gateway.
   */
  app.post("/v1/escrow/record", async (req, reply) => {
    const parsed = CreateEscrowSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.flatten() });
    }

    const { serviceId, merchantAddress, amountSun, buyerAddress, createTxId, escrowId } = parsed.data;

    // Record in SQLite
    const localId = insertEscrow(db, {
      escrowId,
      serviceId,
      buyer: buyerAddress,
      merchant: merchantAddress,
      amountSun,
      createTx: createTxId,
    });

    insertRiskEvent(db, {
      actor: "escrow",
      action: "allow",
      severity: "low",
      reason: "escrow_created",
      details: { escrowId, serviceId, buyer: buyerAddress, merchant: merchantAddress, amountSun, createTxId },
    });

    return reply.code(201).send({
      ok: true,
      localId,
      escrowId,
      status: "created",
      explorerTx: `https://nile.tronscan.org/#/transaction/${createTxId}`,
      explorerContract: escrowAddress
        ? `https://nile.tronscan.org/#/contract/${escrowAddress}`
        : null,
    });
  });

  /**
   * GET /v1/escrow/:id — Get escrow status (on-chain + SQLite enriched).
   */
  app.get("/v1/escrow/:id", async (req, reply) => {
    const params = req.params as { id?: string };
    const escrowId = Number(params.id ?? "");
    if (isNaN(escrowId) || escrowId < 0) {
      return reply.code(400).send({ error: "invalid_escrow_id" });
    }

    // Try on-chain first
    let onChain: Record<string, unknown> | null = null;
    if (escrowAddress) {
      try {
        const abi = loadEscrowAbi();
        if (abi.length > 0) {
          const contract = await tronWeb.contract(abi, escrowAddress);
          const result = await contract.getEscrow(escrowId).call();
          const statusMap = ["created", "disputed", "released", "resolved"];
          onChain = {
            buyer: tronWeb.address.fromHex(result.buyer),
            merchant: tronWeb.address.fromHex(result.merchant),
            amount: result.amount.toString(),
            serviceId: result.serviceId,
            createdBlock: Number(result.createdBlock),
            lockBlocks: Number(result.lockBlocks),
            status: statusMap[Number(result.status)] ?? "unknown",
          };
        }
      } catch {
        // Contract not accessible or escrow doesn't exist
      }
    }

    // SQLite enrichment
    const local = getEscrowByChainId(db, escrowId);

    if (!onChain && !local) {
      return reply.code(404).send({ error: "escrow_not_found" });
    }

    return {
      escrowId,
      onChain,
      local: local ? {
        serviceId: local.service_id,
        buyer: local.buyer,
        merchant: local.merchant,
        amountSun: local.amount_sun,
        status: local.status,
        createTx: local.create_tx,
        disputeTx: local.dispute_tx,
        resolveTx: local.resolve_tx,
        claimTx: local.claim_tx,
        disputeReason: local.dispute_reason,
        buyerPct: local.buyer_pct,
        createdAt: new Date(local.created_at).toISOString(),
      } : null,
      explorerContract: escrowAddress
        ? `https://nile.tronscan.org/#/contract/${escrowAddress}`
        : null,
    };
  });

  /**
   * POST /v1/escrow/:id/dispute — Record a dispute.
   */
  app.post("/v1/escrow/:id/dispute", async (req, reply) => {
    const params = req.params as { id?: string };
    const escrowId = Number(params.id ?? "");
    const parsed = DisputeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.flatten() });
    }

    const local = getEscrowByChainId(db, escrowId);
    if (!local) {
      return reply.code(404).send({ error: "escrow_not_found" });
    }
    if (local.status !== "created") {
      return reply.code(400).send({ error: "invalid_status", message: `Escrow is ${local.status}, not created.` });
    }

    updateEscrowStatus(db, escrowId, "disputed", {
      disputeReason: parsed.data.reason,
      disputeTx: parsed.data.disputeTxId,
    });

    insertRiskEvent(db, {
      actor: "escrow",
      action: "warn",
      severity: "medium",
      reason: "escrow_disputed",
      details: { escrowId, reason: parsed.data.reason },
    });

    return { ok: true, escrowId, status: "disputed", reason: parsed.data.reason };
  });

  /**
   * POST /v1/escrow/:id/resolve — Arbitrator resolves a disputed escrow.
   * The gateway calls resolveDispute() on-chain, then records here.
   */
  app.post("/v1/escrow/:id/resolve", async (req, reply) => {
    if (!checkAdminAuth(req.headers.authorization)) {
      return reply.code(403).send({ error: "forbidden", message: "Admin API key required for dispute resolution." });
    }
    const params = req.params as { id?: string };
    const escrowId = Number(params.id ?? "");
    const parsed = ResolveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.flatten() });
    }

    const local = getEscrowByChainId(db, escrowId);
    if (!local) {
      return reply.code(404).send({ error: "escrow_not_found" });
    }
    if (local.status !== "disputed") {
      return reply.code(400).send({ error: "invalid_status", message: `Escrow is ${local.status}, not disputed.` });
    }

    // Try to resolve on-chain if gateway key is configured
    let resolveTxId: string | undefined;
    if (escrowAddress && config.gatewayPrivateKey) {
      try {
        const abi = loadEscrowAbi();
        if (abi.length > 0) {
          const TronWebModule = (await import("tronweb")).default;
          const gwTronWeb = new TronWebModule.TronWeb({
            fullHost: config.fullHost,
            privateKey: config.gatewayPrivateKey,
          });
          const contract = await gwTronWeb.contract(abi, escrowAddress);
          const tx = await contract.resolveDispute(escrowId, parsed.data.buyerPct).send({
            feeLimit: 100_000_000,
          });
          resolveTxId = typeof tx === "string" ? tx : (tx as { txid?: string }).txid;
        }
      } catch (e) {
        insertRiskEvent(db, {
          actor: "escrow",
          action: "warn",
          severity: "high",
          reason: "escrow_resolve_onchain_failed",
          details: { escrowId, error: String(e) },
        });
      }
    }

    updateEscrowStatus(db, escrowId, "resolved", {
      buyerPct: parsed.data.buyerPct,
      resolveTx: resolveTxId,
    });

    insertRiskEvent(db, {
      actor: "escrow",
      action: "allow",
      severity: "low",
      reason: "escrow_resolved",
      details: { escrowId, buyerPct: parsed.data.buyerPct, resolveTxId },
    });

    return {
      ok: true,
      escrowId,
      status: "resolved",
      buyerPct: parsed.data.buyerPct,
      resolveTxId: resolveTxId ?? null,
      explorerTx: resolveTxId
        ? `https://nile.tronscan.org/#/transaction/${resolveTxId}`
        : null,
    };
  });

  /**
   * POST /v1/escrow/:id/claim — Record a merchant claim.
   */
  app.post("/v1/escrow/:id/claim", async (req, reply) => {
    const params = req.params as { id?: string };
    const escrowId = Number(params.id ?? "");
    const body = req.body as { claimTxId?: string } | undefined;

    const local = getEscrowByChainId(db, escrowId);
    if (!local) {
      return reply.code(404).send({ error: "escrow_not_found" });
    }
    if (local.status !== "created") {
      return reply.code(400).send({ error: "invalid_status", message: `Escrow is ${local.status}, not created.` });
    }

    updateEscrowStatus(db, escrowId, "released", { claimTx: body?.claimTxId });

    insertRiskEvent(db, {
      actor: "escrow",
      action: "allow",
      severity: "low",
      reason: "escrow_claimed",
      details: { escrowId, claimTxId: body?.claimTxId },
    });

    return { ok: true, escrowId, status: "released" };
  });

  /**
   * GET /v1/escrow — List escrows with optional filters.
   */
  app.get("/v1/escrow", async (req) => {
    const q = req.query as { limit?: string; buyer?: string; merchant?: string; status?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20)));
    const rows = listEscrows(db, {
      limit,
      buyer: q.buyer?.trim(),
      merchant: q.merchant?.trim(),
      status: q.status?.trim(),
    });

    return {
      network: "tron-nile",
      contractAddress: escrowAddress || null,
      rows: rows.map((r) => ({
        escrowId: r.escrow_id,
        serviceId: r.service_id,
        buyer: r.buyer,
        merchant: r.merchant,
        amountSun: r.amount_sun,
        status: r.status,
        createTx: r.create_tx,
        disputeReason: r.dispute_reason,
        buyerPct: r.buyer_pct,
        createdAt: new Date(r.created_at).toISOString(),
        explorerTx: r.create_tx
          ? `https://nile.tronscan.org/#/transaction/${r.create_tx}`
          : null,
      })),
    };
  });
}
