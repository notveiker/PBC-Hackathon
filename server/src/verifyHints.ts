/** Short, actionable copy for API clients / UI when on-chain verification fails. */
export function hintForVerifyFailure(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("could not fetch") || r.includes("not found")) {
    return "Use a Nile txid (not mainnet). Wait a few seconds after broadcast, then retry.";
  }
  if (r.includes("recipient mismatch")) {
    return "Send to paymentRequired.recipient exactly (merchant Base58).";
  }
  if (r.includes("amount too low")) {
    return "Send at least the listed amount in minimal units (USDT: 6 decimals).";
  }
  if (r.includes("wrong contract")) {
    return "USDT must be sent via the Nile USDT contract in server config; check TRON_NILE_USDT_CONTRACT.";
  }
  if (r.includes("not an erc20 transfer") || r.includes("triggersmartcontract")) {
    return "For USDT, send a standard TRC-20 transfer to the merchant (not TRX native).";
  }
  if (r.includes("expected transfercontract")) {
    return "For TRX, use a native TRX transfer (not a contract call).";
  }
  if (r.includes("not success") || r.includes("contract execution")) {
    return "On-chain failure (e.g. OUT OF ENERGY). Keep Nile TRX for bandwidth/energy; raise feeLimit for TRC-20.";
  }
  if (r.includes("not yet confirmed")) {
    return "Wait for one block confirmation on Nile, then retry with the same headers.";
  }
  return "Open the tx on Nile Tronscan and compare it to paymentRequired (asset, amount, recipient).";
}
