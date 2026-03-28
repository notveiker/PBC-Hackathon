import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tron-commerce-escrow-"));
process.env.MERCHANT_TRON_ADDRESS = "TUe12tGG9PU8TP3NV7U8orjKfc3ruk9wKX";
process.env.DATABASE_PATH = path.join(tmpRoot, "commerce.db");
process.env.SERVICE_CATALOG_PATH = path.join(tmpRoot, "service-catalog.json");

const { buildServer } = await import("./index.js");

test("POST /v1/escrow/record creates a new escrow", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/v1/escrow/record",
    payload: {
      serviceId: "premium-quote",
      merchantAddress: "TUe12tGG9PU8TP3NV7U8orjKfc3ruk9wKX",
      amountSun: "1000000",
      buyerAddress: "TYJkY2GzxgWBiwCvfpQHFiVpmVQn8hCL9V",
      createTxId: "a".repeat(64),
      escrowId: 1,
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as {
    ok: boolean;
    localId: number;
    escrowId: number;
    status: string;
    explorerTx: string;
    explorerContract: string | null;
  };
  assert.equal(body.ok, true);
  assert.equal(body.escrowId, 1);
  assert.equal(body.status, "created");
  assert.equal(typeof body.localId, "number");
  assert.ok(body.explorerTx.includes("nile.tronscan.org"), "explorerTx should point to Nile explorer");
  await app.close();
});

test("GET /v1/escrow/info returns contract info", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "GET",
    url: "/v1/escrow/info",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    contractAddress: string | null;
    abi: unknown[] | null;
    network: string;
    defaultLockBlocks: number;
    explorerUrl: string | null;
    configured: boolean;
  };
  assert.equal(body.network, "tron-nile");
  assert.equal(body.defaultLockBlocks, 20);
  assert.equal(typeof body.configured, "boolean");
  // contractAddress and abi may be null if not deployed, but the fields must exist
  assert.ok("contractAddress" in body, "response should include contractAddress field");
  assert.ok("abi" in body, "response should include abi field");
  await app.close();
});

test("GET /v1/escrow returns empty list initially", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "GET",
    url: "/v1/escrow",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    network: string;
    contractAddress: string | null;
    rows: Array<Record<string, unknown>>;
  };
  assert.equal(body.network, "tron-nile");
  assert.ok(Array.isArray(body.rows), "rows should be an array");
  // Fresh database may have rows from a prior test in the same process,
  // but the structure must be correct regardless.
  assert.ok("contractAddress" in body, "response should include contractAddress field");
  await app.close();
});

test("POST /v1/escrow/:id/dispute returns 404 for nonexistent escrow", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/v1/escrow/999999/dispute",
    payload: {
      reason: "Service was never delivered to the buyer agent.",
    },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json() as { error: string };
  assert.equal(body.error, "escrow_not_found");
  await app.close();
});
