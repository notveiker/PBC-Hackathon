import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import type { PendingPayment } from "./memoryStore.js";
import { PENDING_PAYMENT_TTL_MS } from "./memoryStore.js";

export type SettlementRow = {
  id: number;
  tx_id: string;
  nonce: string;
  resource: string;
  merchant_id: string;
  payer: string;
  merchant: string;
  asset: string;
  amount_units: string;
  block_number: number | null;
  created_at: number;
};

export type RiskEventRow = {
  id: number;
  actor: string;
  action: string;
  severity: string;
  service_path: string | null;
  merchant_id: string | null;
  reason: string;
  details_json: string | null;
  created_at: number;
};

export type UcpOrderRow = {
  order_id: string;
  service_id: string;
  resource: string;
  merchant_id: string;
  buyer: string | null;
  quantity: number;
  asset: string;
  amount_units: string;
  recipient: string;
  nonce: string;
  raw_idempotency_key: string;
  status: string;
  payment_tx: string | null;
  settlement_id: number | null;
  created_at: number;
  updated_at: number;
};

type PendingPaymentRow = {
  nonce: string;
  amount_units: string;
  recipient: string;
  merchant_id: string;
  asset: "TRX" | "USDT";
  contract_address: string | null;
  created_at: number;
  idempotency_key: string | null;
};

let dbSingleton: Database.Database | null = null;

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    db.exec(ddl);
  }
}

export function openDb(dbFilePath: string): Database.Database {
  if (dbSingleton) return dbSingleton;
  fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
  const db = new Database(dbFilePath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_id TEXT NOT NULL UNIQUE,
      nonce TEXT NOT NULL,
      resource TEXT NOT NULL,
      merchant_id TEXT NOT NULL DEFAULT '',
      payer TEXT NOT NULL,
      merchant TEXT NOT NULL,
      asset TEXT NOT NULL,
      amount_units TEXT NOT NULL,
      block_number INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_settlements_created ON settlements(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_settlements_payer ON settlements(payer);
    CREATE TABLE IF NOT EXISTS pending_payments (
      nonce TEXT PRIMARY KEY,
      amount_units TEXT NOT NULL,
      recipient TEXT NOT NULL,
      merchant_id TEXT NOT NULL DEFAULT '',
      asset TEXT NOT NULL,
      contract_address TEXT,
      created_at INTEGER NOT NULL,
      idempotency_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_payments(created_at DESC);
    CREATE TABLE IF NOT EXISTS risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      severity TEXT NOT NULL,
      service_path TEXT,
      merchant_id TEXT,
      reason TEXT NOT NULL,
      details_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_risk_events_created ON risk_events(created_at DESC);
    CREATE TABLE IF NOT EXISTS escrows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      escrow_id INTEGER NOT NULL,
      service_id TEXT NOT NULL,
      buyer TEXT NOT NULL,
      merchant TEXT NOT NULL,
      amount_sun TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      create_tx TEXT,
      dispute_tx TEXT,
      resolve_tx TEXT,
      claim_tx TEXT,
      dispute_reason TEXT,
      buyer_pct INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_escrows_status ON escrows(status);
    CREATE INDEX IF NOT EXISTS idx_escrows_buyer ON escrows(buyer);
    CREATE TABLE IF NOT EXISTS agent_profiles (
      address TEXT PRIMARY KEY,
      metadata_uri TEXT NOT NULL,
      reputation INTEGER NOT NULL DEFAULT 0,
      total_transactions INTEGER NOT NULL DEFAULT 0,
      registered_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ucp_orders (
      order_id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      merchant_id TEXT NOT NULL,
      buyer TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      asset TEXT NOT NULL,
      amount_units TEXT NOT NULL,
      recipient TEXT NOT NULL,
      nonce TEXT NOT NULL UNIQUE,
      raw_idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'payment_required',
      payment_tx TEXT,
      settlement_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ucp_orders_status ON ucp_orders(status);
    CREATE INDEX IF NOT EXISTS idx_ucp_orders_service ON ucp_orders(service_id, created_at DESC);
  `);
  ensureColumn(
    db,
    "settlements",
    "merchant_id",
    `ALTER TABLE settlements ADD COLUMN merchant_id TEXT NOT NULL DEFAULT ''`
  );
  ensureColumn(
    db,
    "pending_payments",
    "merchant_id",
    `ALTER TABLE pending_payments ADD COLUMN merchant_id TEXT NOT NULL DEFAULT ''`
  );
  db.exec(`
    UPDATE settlements
    SET merchant_id = CASE
      WHEN resource = '/v1/agent/premium-quote' THEN 'market-alpha'
      WHEN resource = '/v1/agent/market-depth' THEN 'depth-vault'
      ELSE merchant_id
    END
    WHERE merchant_id = '';
    UPDATE pending_payments
    SET merchant_id = CASE
      WHEN idempotency_key LIKE '/v1/agent/premium-quote::%' THEN 'market-alpha'
      WHEN idempotency_key LIKE '/v1/agent/market-depth::%' THEN 'depth-vault'
      ELSE merchant_id
    END
    WHERE merchant_id = '';
  `);
  dbSingleton = db;
  return db;
}

function hydratePending(row: PendingPaymentRow | undefined): PendingPayment | undefined {
  if (!row) return undefined;
  return {
    nonce: row.nonce,
    amountSun: BigInt(row.amount_units),
    recipientBase58: row.recipient,
    merchantId: row.merchant_id,
    asset: row.asset,
    contractAddress: row.contract_address ?? undefined,
    createdAt: row.created_at,
    idempotencyKey: row.idempotency_key ?? undefined,
  };
}

export function sweepExpiredPendingPayments(db: Database.Database): number {
  const cutoff = Date.now() - PENDING_PAYMENT_TTL_MS;
  const info = db.prepare(`DELETE FROM pending_payments WHERE created_at < ?`).run(cutoff);
  return info.changes;
}

export function createPendingPayment(
  db: Database.Database,
  input: Omit<PendingPayment, "nonce" | "createdAt"> & { idempotencyKey?: string }
): PendingPayment {
  sweepExpiredPendingPayments(db);

  if (input.idempotencyKey) {
    const existing = hydratePending(
      db
        .prepare(
          `SELECT nonce, amount_units, recipient, asset, contract_address, created_at, idempotency_key
           , merchant_id
           FROM pending_payments
           WHERE idempotency_key = ?`
        )
        .get(input.idempotencyKey) as PendingPaymentRow | undefined
    );
    if (existing) return existing;
  }

  const row: PendingPayment = {
    nonce: randomBytes(16).toString("hex"),
    amountSun: input.amountSun,
    recipientBase58: input.recipientBase58,
    merchantId: input.merchantId,
    asset: input.asset,
    contractAddress: input.contractAddress,
    createdAt: Date.now(),
    idempotencyKey: input.idempotencyKey,
  };

  db.prepare(
    `INSERT INTO pending_payments (nonce, amount_units, recipient, merchant_id, asset, contract_address, created_at, idempotency_key)
     VALUES (@nonce, @amountUnits, @recipient, @merchantId, @asset, @contractAddress, @createdAt, @idempotencyKey)`
  ).run({
    nonce: row.nonce,
    amountUnits: row.amountSun.toString(),
    recipient: row.recipientBase58,
    merchantId: row.merchantId,
    asset: row.asset,
    contractAddress: row.contractAddress ?? null,
    createdAt: row.createdAt,
    idempotencyKey: row.idempotencyKey ?? null,
  });

  return row;
}

export function getPendingPayment(
  db: Database.Database,
  nonce: string
): PendingPayment | undefined {
  const row = hydratePending(
    db
      .prepare(
        `SELECT nonce, amount_units, recipient, merchant_id, asset, contract_address, created_at, idempotency_key
         FROM pending_payments
         WHERE nonce = ?`
      )
      .get(nonce) as PendingPaymentRow | undefined
  );
  if (!row) return undefined;
  if (Date.now() - row.createdAt > PENDING_PAYMENT_TTL_MS) {
    removePendingPayment(db, nonce);
    return undefined;
  }
  return row;
}

export function removePendingPayment(db: Database.Database, nonce: string): void {
  db.prepare(`DELETE FROM pending_payments WHERE nonce = ?`).run(nonce);
}

export function listPendingPayments(db: Database.Database, limit = 100): PendingPayment[] {
  sweepExpiredPendingPayments(db);
  const rows = db
    .prepare(
      `SELECT nonce, amount_units, recipient, merchant_id, asset, contract_address, created_at, idempotency_key
       FROM pending_payments
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit) as PendingPaymentRow[];
  return rows.map((row) => hydratePending(row)).filter((row): row is PendingPayment => Boolean(row));
}

export function pendingPaymentSummary(db: Database.Database): {
  totalPending: number;
  oldestPendingAgeSec: number | null;
} {
  sweepExpiredPendingPayments(db);
  const countRow = db.prepare(`SELECT COUNT(*) AS c FROM pending_payments`).get() as { c: number };
  const oldestRow = db
    .prepare(`SELECT created_at FROM pending_payments ORDER BY created_at ASC LIMIT 1`)
    .get() as { created_at?: number } | undefined;
  return {
    totalPending: countRow.c,
    oldestPendingAgeSec:
      typeof oldestRow?.created_at === "number"
        ? Math.max(0, Math.floor((Date.now() - oldestRow.created_at) / 1000))
        : null,
  };
}

export function insertRiskEvent(
  db: Database.Database,
  input: {
    actor: string;
    action: string;
    severity: string;
    servicePath?: string;
    merchantId?: string;
    reason: string;
    details?: Record<string, unknown>;
  }
): number {
  const info = db.prepare(
    `INSERT INTO risk_events (actor, action, severity, service_path, merchant_id, reason, details_json, created_at)
     VALUES (@actor, @action, @severity, @servicePath, @merchantId, @reason, @detailsJson, @createdAt)`
  ).run({
    actor: input.actor,
    action: input.action,
    severity: input.severity,
    servicePath: input.servicePath ?? null,
    merchantId: input.merchantId ?? null,
    reason: input.reason,
    detailsJson: input.details ? JSON.stringify(input.details) : null,
    createdAt: Date.now(),
  });
  return Number(info.lastInsertRowid);
}

export function listRiskEvents(
  db: Database.Database,
  opts: { limit: number; actor?: string }
): RiskEventRow[] {
  if (opts.actor) {
    return db.prepare(
      `SELECT id, actor, action, severity, service_path, merchant_id, reason, details_json, created_at
       FROM risk_events
       WHERE actor = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(opts.actor, opts.limit) as RiskEventRow[];
  }
  return db.prepare(
    `SELECT id, actor, action, severity, service_path, merchant_id, reason, details_json, created_at
     FROM risk_events
     ORDER BY created_at DESC LIMIT ?`
  ).all(opts.limit) as RiskEventRow[];
}

export function isTxConsumed(db: Database.Database, txId: string): boolean {
  const row = db.prepare(`SELECT 1 FROM settlements WHERE tx_id = ?`).get(txId) as
    | { 1: number }
    | undefined;
  return Boolean(row);
}

export function insertSettlement(
  db: Database.Database,
  input: {
    txId: string;
    nonce: string;
    resource: string;
    merchantId: string;
    payer: string;
    merchant: string;
    asset: PendingPayment["asset"];
    amountUnits: bigint;
    blockNumber: number;
  }
): number {
  const info = db
    .prepare(
      `INSERT INTO settlements (tx_id, nonce, resource, merchant_id, payer, merchant, asset, amount_units, block_number, created_at)
       VALUES (@txId, @nonce, @resource, @merchantId, @payer, @merchant, @asset, @amountUnits, @blockNumber, @createdAt)`
    )
    .run({
      txId: input.txId,
      nonce: input.nonce,
      resource: input.resource,
      merchantId: input.merchantId,
      payer: input.payer,
      merchant: input.merchant,
      asset: input.asset,
      amountUnits: input.amountUnits.toString(),
      blockNumber: input.blockNumber,
      createdAt: Date.now(),
    });
  return Number(info.lastInsertRowid);
}

export function listSettlements(
  db: Database.Database,
  opts: { limit: number; offset: number; merchantId?: string }
): SettlementRow[] {
  if (opts.merchantId) {
    return db
      .prepare(
        `SELECT id, tx_id, nonce, resource, merchant_id, payer, merchant, asset, amount_units, block_number, created_at
         FROM settlements
         WHERE merchant_id = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(opts.merchantId, opts.limit, opts.offset) as SettlementRow[];
  }

  return db
    .prepare(
      `SELECT id, tx_id, nonce, resource, merchant_id, payer, merchant, asset, amount_units, block_number, created_at
       FROM settlements ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(opts.limit, opts.offset) as SettlementRow[];
}

export function settlementSummary(db: Database.Database, merchantId?: string): {
  totalCount: number;
  totalUsdtLike: string;
  since24h: number;
} {
  const totalCountRow = (
    merchantId
      ? db.prepare(`SELECT COUNT(*) AS c FROM settlements WHERE merchant_id = ?`).get(merchantId)
      : db.prepare(`SELECT COUNT(*) AS c FROM settlements`).get()
  ) as { c: number };
  const totalCount = totalCountRow.c;
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const sinceRow = (
    merchantId
      ? db.prepare(`SELECT COUNT(*) AS c FROM settlements WHERE merchant_id = ? AND created_at >= ?`).get(merchantId, since)
      : db.prepare(`SELECT COUNT(*) AS c FROM settlements WHERE created_at >= ?`).get(since)
  ) as { c: number };
  const since24h = sinceRow.c;
  /** Sum USDT rows only (asset = USDT) — minimal units as string */
  const usdtRows = db
    .prepare(
      merchantId
        ? `SELECT amount_units FROM settlements WHERE asset = 'USDT' AND merchant_id = ?`
        : `SELECT amount_units FROM settlements WHERE asset = 'USDT'`
    )
    .all(...(merchantId ? [merchantId] : [])) as { amount_units: string }[];
  let sum = 0n;
  for (const r of usdtRows) {
    sum += BigInt(r.amount_units);
  }
  return { totalCount, totalUsdtLike: sum.toString(), since24h };
}

// ── UCP checkout / order tracking ───────────────────────────────────────────

export function insertUcpOrder(
  db: Database.Database,
  input: {
    orderId: string;
    serviceId: string;
    resource: string;
    merchantId: string;
    buyer?: string;
    quantity: number;
    asset: "TRX" | "USDT";
    amountUnits: bigint;
    recipient: string;
    nonce: string;
    rawIdempotencyKey: string;
  }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO ucp_orders (
      order_id, service_id, resource, merchant_id, buyer, quantity, asset, amount_units,
      recipient, nonce, raw_idempotency_key, status, created_at, updated_at
    )
    VALUES (
      @orderId, @serviceId, @resource, @merchantId, @buyer, @quantity, @asset, @amountUnits,
      @recipient, @nonce, @rawIdempotencyKey, 'payment_required', @createdAt, @updatedAt
    )`
  ).run({
    orderId: input.orderId,
    serviceId: input.serviceId,
    resource: input.resource,
    merchantId: input.merchantId,
    buyer: input.buyer ?? null,
    quantity: input.quantity,
    asset: input.asset,
    amountUnits: input.amountUnits.toString(),
    recipient: input.recipient,
    nonce: input.nonce,
    rawIdempotencyKey: input.rawIdempotencyKey,
    createdAt: now,
    updatedAt: now,
  });
}

export function getUcpOrder(
  db: Database.Database,
  orderId: string
): UcpOrderRow | undefined {
  return db.prepare(`SELECT * FROM ucp_orders WHERE order_id = ?`).get(orderId) as
    | UcpOrderRow
    | undefined;
}

export function markUcpOrderSettled(
  db: Database.Database,
  nonce: string,
  txId: string,
  settlementId: number
): void {
  db.prepare(
    `UPDATE ucp_orders
     SET status = 'fulfilled', payment_tx = @txId, settlement_id = @settlementId, updated_at = @updatedAt
     WHERE nonce = @nonce`
  ).run({
    nonce,
    txId,
    settlementId,
    updatedAt: Date.now(),
  });
}

// ── Escrow CRUD ──────────────────────────────────────────────────────────────

export type EscrowRow = {
  id: number;
  escrow_id: number;
  service_id: string;
  buyer: string;
  merchant: string;
  amount_sun: string;
  status: string;
  create_tx: string | null;
  dispute_tx: string | null;
  resolve_tx: string | null;
  claim_tx: string | null;
  dispute_reason: string | null;
  buyer_pct: number | null;
  created_at: number;
};

export function insertEscrow(
  db: Database.Database,
  input: {
    escrowId: number;
    serviceId: string;
    buyer: string;
    merchant: string;
    amountSun: string;
    createTx: string;
  }
): number {
  const info = db.prepare(
    `INSERT INTO escrows (escrow_id, service_id, buyer, merchant, amount_sun, status, create_tx, created_at)
     VALUES (@escrowId, @serviceId, @buyer, @merchant, @amountSun, 'created', @createTx, @createdAt)`
  ).run({
    escrowId: input.escrowId,
    serviceId: input.serviceId,
    buyer: input.buyer,
    merchant: input.merchant,
    amountSun: input.amountSun,
    createTx: input.createTx,
    createdAt: Date.now(),
  });
  return Number(info.lastInsertRowid);
}

export function getEscrowByChainId(db: Database.Database, escrowId: number): EscrowRow | undefined {
  return db.prepare(
    `SELECT * FROM escrows WHERE escrow_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(escrowId) as EscrowRow | undefined;
}

export function updateEscrowStatus(
  db: Database.Database,
  escrowId: number,
  status: string,
  extra?: { disputeTx?: string; resolveTx?: string; claimTx?: string; disputeReason?: string; buyerPct?: number }
): void {
  const sets = ["status = @status"];
  const params: Record<string, unknown> = { escrowId, status };

  if (extra?.disputeTx) { sets.push("dispute_tx = @disputeTx"); params.disputeTx = extra.disputeTx; }
  if (extra?.resolveTx) { sets.push("resolve_tx = @resolveTx"); params.resolveTx = extra.resolveTx; }
  if (extra?.claimTx) { sets.push("claim_tx = @claimTx"); params.claimTx = extra.claimTx; }
  if (extra?.disputeReason) { sets.push("dispute_reason = @disputeReason"); params.disputeReason = extra.disputeReason; }
  if (extra?.buyerPct !== undefined) { sets.push("buyer_pct = @buyerPct"); params.buyerPct = extra.buyerPct; }

  db.prepare(`UPDATE escrows SET ${sets.join(", ")} WHERE escrow_id = @escrowId`).run(params);
}

export function listEscrows(
  db: Database.Database,
  opts: { limit: number; buyer?: string; merchant?: string; status?: string }
): EscrowRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.buyer) { where.push("buyer = ?"); params.push(opts.buyer); }
  if (opts.merchant) { where.push("merchant = ?"); params.push(opts.merchant); }
  if (opts.status) { where.push("status = ?"); params.push(opts.status); }

  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(opts.limit);

  return db.prepare(
    `SELECT * FROM escrows ${clause} ORDER BY created_at DESC LIMIT ?`
  ).all(...params) as EscrowRow[];
}

// ── Agent Profile CRUD ───────────────────────────────────────────────────────

export type AgentProfileRow = {
  address: string;
  metadata_uri: string;
  reputation: number;
  total_transactions: number;
  registered_at: number;
};

export function upsertAgentProfile(
  db: Database.Database,
  input: { address: string; metadataUri: string; reputation?: number; totalTransactions?: number }
): void {
  db.prepare(
    `INSERT INTO agent_profiles (address, metadata_uri, reputation, total_transactions, registered_at)
     VALUES (@address, @metadataUri, @reputation, @totalTransactions, @registeredAt)
     ON CONFLICT(address) DO UPDATE SET
       metadata_uri = @metadataUri,
       reputation = COALESCE(@reputation, agent_profiles.reputation),
       total_transactions = COALESCE(@totalTransactions, agent_profiles.total_transactions)`
  ).run({
    address: input.address,
    metadataUri: input.metadataUri,
    reputation: input.reputation ?? 0,
    totalTransactions: input.totalTransactions ?? 0,
    registeredAt: Date.now(),
  });
}

export function getAgentProfile(db: Database.Database, address: string): AgentProfileRow | undefined {
  return db.prepare(`SELECT * FROM agent_profiles WHERE address = ?`).get(address) as AgentProfileRow | undefined;
}

export function updateAgentReputation(db: Database.Database, address: string, delta: number): void {
  db.prepare(`UPDATE agent_profiles SET reputation = reputation + ? WHERE address = ?`).run(delta, address);
}

export function listAgentProfiles(db: Database.Database, limit: number = 50): AgentProfileRow[] {
  return db.prepare(
    `SELECT * FROM agent_profiles ORDER BY reputation DESC LIMIT ?`
  ).all(limit) as AgentProfileRow[];
}

export function spendingReport(
  db: Database.Database,
  payer: string,
  sinceMsAgo: number = 24 * 60 * 60 * 1000
): {
  payer: string;
  totalUsdtUnits: string;
  totalTrxSun: string;
  txCount: number;
  merchantBreakdown: { merchantId: string; count: number; totalUnits: string }[];
} {
  const since = Date.now() - sinceMsAgo;
  const rows = db.prepare(
    `SELECT merchant_id, asset, amount_units FROM settlements WHERE payer = ? AND created_at >= ?`
  ).all(payer, since) as { merchant_id: string; asset: string; amount_units: string }[];

  let totalUsdt = 0n;
  let totalTrx = 0n;
  const merchants = new Map<string, { count: number; total: bigint }>();

  for (const r of rows) {
    const amt = BigInt(r.amount_units);
    if (r.asset === "USDT") totalUsdt += amt;
    else totalTrx += amt;

    const m = merchants.get(r.merchant_id) ?? { count: 0, total: 0n };
    m.count++;
    m.total += amt;
    merchants.set(r.merchant_id, m);
  }

  return {
    payer,
    totalUsdtUnits: totalUsdt.toString(),
    totalTrxSun: totalTrx.toString(),
    txCount: rows.length,
    merchantBreakdown: Array.from(merchants.entries()).map(([merchantId, v]) => ({
      merchantId,
      count: v.count,
      totalUnits: v.total.toString(),
    })),
  };
}
