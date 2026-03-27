import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hintForVerifyFailure } from "./verifyHints.js";

describe("hintForVerifyFailure", () => {
  it("suggests Nile for fetch errors", () => {
    const h = hintForVerifyFailure("Could not fetch transaction: timeout");
    assert.match(h, /Nile/i);
  });

  it("suggests correct recipient for mismatch", () => {
    const h = hintForVerifyFailure("Recipient mismatch: expected TAAA, got TBBB");
    assert.match(h, /recipient/i);
  });

  it("mentions energy for failed execution", () => {
    const h = hintForVerifyFailure("Contract execution not SUCCESS: OUT_OF_ENERGY");
    assert.match(h, /Energy|energy/i);
  });
});
