import TronWebModule from "tronweb";
import type { PendingPayment } from "./memoryStore.js";

const { TronWeb } = TronWebModule;

export type TronWebInstance = InstanceType<typeof TronWeb>;

export type TronClients = {
  tronWeb: TronWebInstance;
};

/** TRON txids are exactly 64 lowercase hex chars */
export function isValidTxId(txId: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(txId);
}

export function createTronWeb(fullHost: string, apiKey?: string): TronClients {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["TRON-PRO-API-KEY"] = apiKey;
  }
  const tronWeb = new TronWeb({
    fullHost,
    headers: Object.keys(headers).length ? headers : undefined,
  });
  return { tronWeb };
}

function hexToBase58(tronWeb: TronWebInstance, hexAddress: string): string {
  if (!hexAddress) return "";
  const with0x = hexAddress.startsWith("0x") ? hexAddress.slice(2) : hexAddress;
  const padded = with0x.length === 40 ? `41${with0x}` : with0x;
  try {
    return tronWeb.address.fromHex(padded);
  } catch {
    try {
      return tronWeb.address.fromHex(with0x);
    } catch {
      return "";
    }
  }
}

/**
 * Verify a Nile/mainnet transaction satisfies a pending TRX payment.
 */
export async function verifyTrxPayment(
  clients: TronClients,
  txId: string,
  pending: PendingPayment,
  minConfirmations: number
): Promise<
  | { ok: true; fromBase58: string; blockNumber: number }
  | { ok: false; reason: string }
> {
  if (!isValidTxId(txId)) {
    return { ok: false, reason: "Invalid transaction ID format (expected 64 hex chars)" };
  }

  const { tronWeb } = clients;

  let tx: Awaited<ReturnType<typeof tronWeb.trx.getTransaction>>;
  try {
    tx = await tronWeb.trx.getTransaction(txId);
  } catch (e) {
    return { ok: false, reason: `Could not fetch transaction: ${String(e)}` };
  }

  if (!tx || (tx as { ret?: unknown[] }).ret?.[0] === undefined) {
    return { ok: false, reason: "Transaction not found or incomplete" };
  }

  const ret = (tx as { ret: { contractRet?: string }[] }).ret;
  if (ret[0]?.contractRet !== "SUCCESS") {
    return { ok: false, reason: `Contract execution not SUCCESS: ${ret[0]?.contractRet}` };
  }

  const info = await tronWeb.trx.getTransactionInfo(txId);
  const blockNumber = info.blockNumber ?? 0;
  if (minConfirmations > 0 && blockNumber <= 0) {
    return { ok: false, reason: "Transaction not yet confirmed in a block" };
  }

  const contracts = (tx as { raw_data?: { contract?: unknown[] } }).raw_data?.contract;
  if (!contracts?.length) {
    return { ok: false, reason: "No contracts in transaction" };
  }

  const c0 = contracts[0] as {
    type?: string;
    parameter?: { value?: Record<string, unknown> };
  };
  if (c0.type !== "TransferContract") {
    return { ok: false, reason: `Expected TransferContract, got ${c0.type}` };
  }

  const value = c0.parameter?.value ?? {};
  const amount = BigInt(String(value.amount ?? 0));
  const toHex = String(value.to_address ?? "");
  const ownerHex = String(value.owner_address ?? "");
  const toBase58 = hexToBase58(tronWeb, toHex);
  const fromBase58 = hexToBase58(tronWeb, ownerHex);

  if (toBase58 !== pending.recipientBase58) {
    return {
      ok: false,
      reason: `Recipient mismatch: expected ${pending.recipientBase58}, got ${toBase58}`,
    };
  }
  if (amount < pending.amountSun) {
    return {
      ok: false,
      reason: `Amount too low: need >= ${pending.amountSun} sun, got ${amount}`,
    };
  }

  return { ok: true, fromBase58, blockNumber };
}

/**
 * Verify TRC20 Transfer to merchant for USDT-style payments.
 */
export async function verifyTrc20Payment(
  clients: TronClients,
  txId: string,
  pending: PendingPayment,
  minConfirmations: number
): Promise<
  | { ok: true; fromBase58: string; blockNumber: number }
  | { ok: false; reason: string }
> {
  if (!isValidTxId(txId)) {
    return { ok: false, reason: "Invalid transaction ID format (expected 64 hex chars)" };
  }

  const { tronWeb } = clients;
  const contract = pending.contractAddress;
  if (!contract) {
    return { ok: false, reason: "Missing USDT contract address in pending payment" };
  }

  let tx: Awaited<ReturnType<typeof tronWeb.trx.getTransaction>>;
  try {
    tx = await tronWeb.trx.getTransaction(txId);
  } catch (e) {
    return { ok: false, reason: `Could not fetch transaction: ${String(e)}` };
  }

  const ret = (tx as { ret?: { contractRet?: string }[] }).ret;
  if (ret?.[0]?.contractRet !== "SUCCESS") {
    return { ok: false, reason: `Contract execution not SUCCESS: ${ret?.[0]?.contractRet}` };
  }

  const info = await tronWeb.trx.getTransactionInfo(txId);
  const blockNumber = info.blockNumber ?? 0;
  if (minConfirmations > 0 && blockNumber <= 0) {
    return { ok: false, reason: "Transaction not yet confirmed in a block" };
  }

  const contracts = (tx as { raw_data?: { contract?: unknown[] } }).raw_data?.contract;
  const trigger = (contracts ?? []).find((c: unknown) => {
    const t = c as { type?: string };
    return t.type === "TriggerSmartContract";
  }) as
    | {
        parameter?: { value?: Record<string, unknown> };
      }
    | undefined;

  if (!trigger?.parameter?.value) {
    return { ok: false, reason: "No TriggerSmartContract in transaction" };
  }

  const val = trigger.parameter.value;
  const contractAddress = tronWeb.address.fromHex(
    String(val.contract_address ?? "").replace(/^0x/, "")
  );
  if (contractAddress !== contract) {
    return {
      ok: false,
      reason: `Wrong contract: expected ${contract}, got ${contractAddress}`,
    };
  }

  const data = String(val.data ?? "");
  // transfer(address,uint256) selector a9059cbb + 32-byte address + 32-byte amount
  if (!data.startsWith("a9059cbb")) {
    return { ok: false, reason: "Not an ERC20 transfer call" };
  }

  const toParam = data.slice(8 + 24, 8 + 64);
  const amountHex = data.slice(8 + 64, 8 + 128);
  const toAddress = tronWeb.address.fromHex("41" + toParam);
  const amount = BigInt("0x" + amountHex);

  const ownerHex = String(val.owner_address ?? "");
  const fromBase58 = hexToBase58(tronWeb, ownerHex);

  if (toAddress !== pending.recipientBase58) {
    return {
      ok: false,
      reason: `Recipient mismatch: expected ${pending.recipientBase58}, got ${toAddress}`,
    };
  }
  if (amount < pending.amountSun) {
    return {
      ok: false,
      reason: `Amount too low: need >= ${pending.amountSun} minimal units, got ${amount}`,
    };
  }

  return { ok: true, fromBase58, blockNumber };
}
