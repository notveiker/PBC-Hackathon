#!/usr/bin/env node
/**
 * Headless "agent" smoke test: GET priced resource → print 402 body.
 * Complete payment in TronLink, then:
 *   RESOURCE_PATH=/v1/agent/premium-quote NONCE=... TXID=... node scripts/agent-demo.mjs
 */
const base = process.env.API_BASE ?? "http://127.0.0.1:3001";
const path = process.env.RESOURCE_PATH ?? "/v1/agent/premium-quote";
const nonce = process.env.NONCE;
const txid = process.env.TXID;
const token = process.env.BEARER;

async function main() {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (nonce && txid) {
    headers["X-Payment-Nonce"] = nonce;
    headers["X-Payment-Tx-Id"] = txid;
  }
  headers["Idempotency-Key"] = `agent-demo-${Date.now()}`;

  const res = await fetch(`${base}${path}`, { headers });
  const body = await res.json().catch(() => ({}));
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (res.status === 402 && body.paymentRequired) {
    console.log("\n--- Next: pay merchant on Nile, then retry with NONCE + TXID env vars. ---\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
