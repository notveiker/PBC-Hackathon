import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tron-commerce-opsec-"));
process.env.MERCHANT_TRON_ADDRESS = "TUe12tGG9PU8TP3NV7U8orjKfc3ruk9wKX";
process.env.DATABASE_PATH = path.join(tmpRoot, "commerce.db");
process.env.SERVICE_CATALOG_PATH = path.join(tmpRoot, "service-catalog.json");

const { buildServer } = await import("./index.js");

test("POST /v1/opsec/simulate with known merchant address returns safe + checks", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/v1/opsec/simulate",
    payload: {
      to: "TUe12tGG9PU8TP3NV7U8orjKfc3ruk9wKX",
      amount: "100000",
      asset: "TRX",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    safe: boolean;
    riskLevel: string;
    checks: Array<{ check: string; passed: boolean; detail?: string }>;
    warnings: string[];
    summary: string;
  };
  // Merchant is known, amount is within cap, not a scam address
  const merchantCheck = body.checks.find((c) => c.check === "recipient_known_merchant");
  assert.ok(merchantCheck, "should include recipient_known_merchant check");
  assert.equal(merchantCheck!.passed, true);

  const amountCheck = body.checks.find((c) => c.check === "amount_within_cap");
  assert.ok(amountCheck, "should include amount_within_cap check");
  assert.equal(amountCheck!.passed, true);

  const scamCheck = body.checks.find((c) => c.check === "not_scam_address");
  assert.ok(scamCheck, "should include not_scam_address check");
  assert.equal(scamCheck!.passed, true);

  assert.ok(Array.isArray(body.checks), "checks should be an array");
  assert.ok(body.checks.length >= 3, "should have at least 3 checks");
  await app.close();
});

test("POST /v1/opsec/simulate with unknown address returns warnings", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/v1/opsec/simulate",
    payload: {
      to: "TYJkY2GzxgWBiwCvfpQHFiVpmVQn8hCL9V",
      amount: "100000",
      asset: "TRX",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    safe: boolean;
    riskLevel: string;
    checks: Array<{ check: string; passed: boolean; detail?: string }>;
    warnings: string[];
    summary: string;
  };
  // Unknown address is not a registered merchant
  const merchantCheck = body.checks.find((c) => c.check === "recipient_known_merchant");
  assert.ok(merchantCheck, "should include recipient_known_merchant check");
  assert.equal(merchantCheck!.passed, false);

  assert.ok(body.warnings.length > 0, "should have at least one warning");
  assert.ok(
    body.warnings.some((w) => w.includes("not a registered merchant")),
    "should warn about unregistered merchant"
  );
  await app.close();
});

test("POST /v1/opsec/analyze-contract with a valid address", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/v1/opsec/analyze-contract",
    payload: {
      address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    address: string;
    isContract: boolean;
    hasCode: boolean;
    knownToken: string | null;
    contractName: string | null;
    riskLevel: string;
    warnings: string[];
    explorerUrl: string;
  };
  assert.equal(body.address, "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf");
  assert.equal(typeof body.isContract, "boolean");
  assert.equal(typeof body.hasCode, "boolean");
  assert.ok(["low", "medium", "high"].includes(body.riskLevel), "riskLevel should be low, medium, or high");
  assert.ok(Array.isArray(body.warnings), "warnings should be an array");
  assert.ok(body.explorerUrl.includes("nile.tronscan.org"), "explorerUrl should point to Nile explorer");
  await app.close();
});

test("GET /v1/opsec/spending-report returns payer_required when no payer given", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "GET",
    url: "/v1/opsec/spending-report",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    error: string;
    message: string;
  };
  assert.equal(body.error, "payer_required");
  assert.ok(body.message.includes("payer"), "message should mention payer parameter");
  await app.close();
});
