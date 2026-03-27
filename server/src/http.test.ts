import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tron-commerce-http-"));
process.env.MERCHANT_TRON_ADDRESS = "TUe12tGG9PU8TP3NV7U8orjKfc3ruk9wKX";
process.env.DATABASE_PATH = path.join(tmpRoot, "commerce.db");
process.env.SERVICE_CATALOG_PATH = path.join(tmpRoot, "service-catalog.json");

const { buildServer } = await import("./index.js");

test("registry exposes signed catalog metadata", async () => {
  const app = await buildServer();
  const res = await app.inject({ method: "GET", url: "/v1/registry" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    merchants: Array<{ id: string; manifestJwt?: string }>;
    services: Array<{ id: string; manifestJwt?: string }>;
  };
  assert.ok(body.merchants.some((merchant) => merchant.id === "market-alpha" && merchant.manifestJwt));
  assert.ok(body.services.some((service) => service.id === "premium-quote" && service.manifestJwt));
  await app.close();
});

test("merchant onboarding is create-only", async () => {
  const app = await buildServer();
  const payload = {
    id: "signal-house",
    name: "Signal House",
    address: "TUe12tGG9PU8TP3NV7U8orjKfc3ruk9wKX",
    trust: {
      verificationStatus: "verified",
      trustScore: 90,
      riskTier: "low",
      identityClaims: ["merchant-address-pinned"],
      controls: ["es256-receipts"],
      profileVersion: 1,
    },
  };

  const first = await app.inject({
    method: "POST",
    url: "/v1/onboard/merchant",
    payload,
  });
  assert.equal(first.statusCode, 201);

  const second = await app.inject({
    method: "POST",
    url: "/v1/onboard/merchant",
    payload,
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, "merchant_exists");
  await app.close();
});

test("service onboarding enforces canonical path and serves 402 on success", async () => {
  const app = await buildServer();

  const bad = await app.inject({
    method: "POST",
    url: "/v1/onboard/service",
    payload: {
      id: "alpha-brief",
      path: "/v1/services/not-alpha-brief",
      handler: "static-json",
      productName: "Alpha Brief",
      merchantId: "market-alpha",
      category: "analytics",
      description: "Canonical route validation should reject this path.",
      returns: "brief payload",
      pricing: { usdtUnits: "250000", trxSun: 250000 },
      trust: {
        riskCategory: "analytics",
        safeguards: ["merchant-manifest-signed"],
        minVerification: "verified",
      },
      staticResponse: { brief: "hello" },
    },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "invalid_service_path");

  const good = await app.inject({
    method: "POST",
    url: "/v1/onboard/service",
    payload: {
      id: "alpha-brief",
      path: "/v1/services/alpha-brief",
      handler: "static-json",
      productName: "Alpha Brief",
      merchantId: "market-alpha",
      category: "analytics",
      description: "Canonical route validation should allow this path.",
      returns: "brief payload",
      pricing: { usdtUnits: "250000", trxSun: 250000 },
      trust: {
        riskCategory: "analytics",
        safeguards: ["merchant-manifest-signed"],
        minVerification: "verified",
      },
      staticResponse: { brief: "hello" },
    },
  });
  assert.equal(good.statusCode, 201);

  const resource = await app.inject({
    method: "GET",
    url: "/v1/services/alpha-brief",
  });
  assert.equal(resource.statusCode, 402);
  assert.equal(resource.json().paymentRequired.resource, "/v1/services/alpha-brief");
  await app.close();
});
