/**
 * Agent Registry Routes — On-chain agent identity and reputation management.
 *
 * Wraps the AgentRegistry smart contract, caches profiles in SQLite,
 * and provides a REST API for registration, lookup, and reputation updates.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config, monorepoRoot, checkAdminAuth } from "./config.js";
import {
  upsertAgentProfile,
  getAgentProfile,
  updateAgentReputation,
  listAgentProfiles,
  insertRiskEvent,
} from "./db.js";
import type { TronWebInstance } from "./tronVerify.js";

// ── Load contract ABI ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAbi = any;

function loadRegistryAbi(): AnyAbi[] {
  const buildPath = path.join(monorepoRoot, "contracts", "build", "AgentRegistry.json");
  if (!fs.existsSync(buildPath)) return [];
  const artifact = JSON.parse(fs.readFileSync(buildPath, "utf-8"));
  return artifact.abi ?? [];
}

// ── Schemas ───────────────────────────────────────────────────────────────

const RegisterSchema = z.object({
  address: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{25,40}$/),
  metadataURI: z.string().min(1).max(500),
  registerTxId: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
});

const ReputationSchema = z.object({
  delta: z.number().int().min(-100).max(100),
  reason: z.string().min(2).max(200),
});

// ── Routes ────────────────────────────────────────────────────────────────

export function registerAgentRegistryRoutes(
  app: FastifyInstance,
  db: Database.Database,
  tronWeb: TronWebInstance
): void {
  const registryAddress = config.agentRegistryContractAddress;

  /**
   * GET /v1/agents/info — Contract address and ABI for frontend/agent.
   */
  app.get("/v1/agents/info", async () => {
    const abi = loadRegistryAbi();
    return {
      contractAddress: registryAddress || null,
      abi: abi.length > 0 ? abi : null,
      network: "tron-nile",
      explorerUrl: registryAddress
        ? `https://nile.tronscan.org/#/contract/${registryAddress}`
        : null,
      configured: Boolean(registryAddress),
    };
  });

  /**
   * POST /v1/agents/register — Register an agent (records on-chain tx + caches in SQLite).
   */
  app.post("/v1/agents/register", async (req, reply) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.flatten() });
    }

    const { address, metadataURI, registerTxId } = parsed.data;

    // Check if already registered in our cache
    const existing = getAgentProfile(db, address);
    if (existing) {
      return reply.code(409).send({
        error: "already_registered",
        message: `Agent ${address} is already registered.`,
        profile: existing,
      });
    }

    // Try to verify on-chain
    let onChainRegistered = false;
    if (registryAddress) {
      try {
        const abi = loadRegistryAbi();
        if (abi.length > 0) {
          const contract = await tronWeb.contract(abi, registryAddress);
          onChainRegistered = await contract.isRegistered(address).call();
        }
      } catch {
        // Contract not accessible
      }
    }

    // Cache in SQLite
    upsertAgentProfile(db, { address, metadataUri: metadataURI });

    insertRiskEvent(db, {
      actor: "agent-registry",
      action: "allow",
      severity: "low",
      reason: "agent_registered",
      details: { address, metadataURI, registerTxId, onChainRegistered },
    });

    return reply.code(201).send({
      ok: true,
      address,
      metadataURI,
      reputation: 0,
      onChainRegistered,
      registerTxId: registerTxId ?? null,
      explorerTx: registerTxId
        ? `https://nile.tronscan.org/#/transaction/${registerTxId}`
        : null,
    });
  });

  /**
   * GET /v1/agents/:address — Fetch agent profile (on-chain + SQLite).
   */
  app.get("/v1/agents/:address", async (req, reply) => {
    const params = req.params as { address?: string };
    const address = params.address?.trim() ?? "";

    if (!/^T[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(address)) {
      return reply.code(400).send({ error: "invalid_address" });
    }

    // Try on-chain
    let onChain: Record<string, unknown> | null = null;
    if (registryAddress) {
      try {
        const abi = loadRegistryAbi();
        if (abi.length > 0) {
          const contract = await tronWeb.contract(abi, registryAddress);
          const result = await contract.getAgent(address).call();
          if (result.registered) {
            onChain = {
              metadataURI: result.metadataURI,
              reputation: Number(result.reputation),
              registeredBlock: Number(result.registeredBlock),
              registered: result.registered,
              totalTransactions: Number(result.totalTransactions),
            };
          }
        }
      } catch {
        // Contract not accessible
      }
    }

    // SQLite cache
    const local = getAgentProfile(db, address);

    if (!onChain && !local) {
      return reply.code(404).send({ error: "agent_not_found", address });
    }

    // Reputation badge
    const reputation = onChain
      ? (onChain.reputation as number)
      : (local?.reputation ?? 0);
    const badge =
      reputation >= 50 ? "gold" :
      reputation >= 20 ? "silver" :
      reputation >= 0 ? "bronze" : "untrusted";

    return {
      address,
      onChain,
      local: local ? {
        metadataUri: local.metadata_uri,
        reputation: local.reputation,
        totalTransactions: local.total_transactions,
        registeredAt: new Date(local.registered_at).toISOString(),
      } : null,
      badge,
      explorerUrl: `https://nile.tronscan.org/#/address/${address}`,
    };
  });

  /**
   * POST /v1/agents/:address/reputation — Update reputation (gateway/admin only).
   */
  app.post("/v1/agents/:address/reputation", async (req, reply) => {
    if (!checkAdminAuth(req.headers.authorization)) {
      return reply.code(403).send({ error: "forbidden", message: "Admin API key required. Set ADMIN_API_KEY and pass as Bearer token." });
    }
    const params = req.params as { address?: string };
    const address = params.address?.trim() ?? "";
    const parsed = ReputationSchema.safeParse(req.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.flatten() });
    }

    const local = getAgentProfile(db, address);
    if (!local) {
      return reply.code(404).send({ error: "agent_not_found", address });
    }

    const { delta, reason } = parsed.data;

    // Try on-chain update
    let onChainTxId: string | undefined;
    if (registryAddress && config.gatewayPrivateKey) {
      try {
        const abi = loadRegistryAbi();
        if (abi.length > 0) {
          const TronWebModule = (await import("tronweb")).default;
          const gwTronWeb = new TronWebModule.TronWeb({
            fullHost: config.fullHost,
            privateKey: config.gatewayPrivateKey,
          });
          const contract = await gwTronWeb.contract(abi, registryAddress);
          const tx = await contract.updateReputation(address, delta).send({
            feeLimit: 100_000_000,
          });
          onChainTxId = typeof tx === "string" ? tx : (tx as { txid?: string }).txid;
        }
      } catch (e) {
        insertRiskEvent(db, {
          actor: "agent-registry",
          action: "warn",
          severity: "medium",
          reason: "reputation_update_onchain_failed",
          details: { address, delta, error: String(e) },
        });
      }
    }

    // Update SQLite
    updateAgentReputation(db, address, delta);

    insertRiskEvent(db, {
      actor: "agent-registry",
      action: "allow",
      severity: "low",
      reason: "reputation_updated",
      details: { address, delta, reason, onChainTxId },
    });

    const updated = getAgentProfile(db, address);
    return {
      ok: true,
      address,
      newReputation: updated?.reputation ?? local.reputation + delta,
      delta,
      reason,
      onChainTxId: onChainTxId ?? null,
    };
  });

  /**
   * GET /v1/agents — List all registered agents.
   */
  app.get("/v1/agents", async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50)));
    const profiles = listAgentProfiles(db, limit);

    return {
      network: "tron-nile",
      contractAddress: registryAddress || null,
      agents: profiles.map((p) => {
        const badge =
          p.reputation >= 50 ? "gold" :
          p.reputation >= 20 ? "silver" :
          p.reputation >= 0 ? "bronze" : "untrusted";
        return {
          address: p.address,
          metadataUri: p.metadata_uri,
          reputation: p.reputation,
          totalTransactions: p.total_transactions,
          badge,
          registeredAt: new Date(p.registered_at).toISOString(),
        };
      }),
    };
  });
}
