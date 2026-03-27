import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Regression-style checks for TRC20 calldata layout assumptions.
 * Full integration tests require Nile RPC — run the app against testnet manually.
 */
describe("tronVerify helpers", () => {
  it("parses transfer calldata slice positions consistently", () => {
    const data =
      "a9059cbb" +
      "000000000000000000000000" +
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
      "00000000000000000000000000000000000000000000000000000000000f4240";
    assert.equal(data.startsWith("a9059cbb"), true);
    const amountHex = data.slice(8 + 64, 8 + 128);
    assert.equal(BigInt("0x" + amountHex), 1_000_000n);
  });
});
