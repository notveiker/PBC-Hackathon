/** Map TronLink / TRON RPC errors to short UX copy (fees, energy, network). */
export function friendlyWalletError(e: unknown): string {
  const s = String(e);
  if (/user denied|user rejected|cancel/i.test(s)) {
    return "Transaction was rejected or cancelled in TronLink.";
  }
  if (/OUT OF ENERGY|out of energy/i.test(s)) {
    return "OUT OF ENERGY: on Nile, freeze test TRX for Energy or burn TRX for fees. USDT transfers need Energy.";
  }
  if (/BANDWIDTH|bandwidth/i.test(s)) {
    return "Not enough Bandwidth: wait for daily free bandwidth or freeze TRX on Nile.";
  }
  if (/invalid.*address|checksum/i.test(s)) {
    return "Invalid address — copy the merchant Base58 from the 402 body.";
  }
  return s.length > 220 ? `${s.slice(0, 220)}…` : s;
}

type TronInjected = {
  fullNode?: { host?: string };
  solidityNode?: { host?: string };
  defaultAddress?: { base58?: string };
};

export function getTronNetworkWarning(tw: TronInjected | null): string | null {
  if (!tw) return null;
  const host = tw.fullNode?.host ?? tw.solidityNode?.host ?? "";
  if (!host) return null;
  const h = host.toLowerCase();
  if (h.includes("nile") || h.includes("nile.trongrid")) return null;
  if (h.includes("shasta")) {
    return "TronLink is on Shasta, but this app verifies Nile. Switch network to Nile Testnet.";
  }
  if (h.includes("trongrid.io") && !h.includes("nile")) {
    return "TronLink looks like mainnet. Switch to Nile Testnet so the server can verify your tx.";
  }
  return null;
}
