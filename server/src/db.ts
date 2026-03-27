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
