import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const monorepoRoot = path.resolve(here, "../..");
dotenv.config({ path: path.join(monorepoRoot, ".env") });
dotenv.config({ path: path.join(monorepoRoot, ".env.local") });
dotenv.config();

const num = (v: string | undefined, fallback: number) =>
  v !== undefined && v !== "" ? Number(v) : fallback;

const big = (v: string | undefined, fallback: bigint) =>
  v !== undefined && v !== "" ? BigInt(v) : fallback;

export const config = {
  port: num(process.env.PORT, 3001),
  /** Optional frontend allowlist for CORS. Empty = allow any origin. */
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Merchant payout address (Base58 T...) — required for payment verification */
  merchantAddress: process.env.MERCHANT_TRON_ADDRESS ?? "",
  /** Optional second merchant to demonstrate a marketplace registry */
  secondaryMerchantAddress: process.env.SECONDARY_MERCHANT_TRON_ADDRESS ?? "",
  /** Nile defaults — override for custom nodes */
  fullHost: process.env.TRON_FULL_HOST ?? "https://nile.trongrid.io",
  /** Optional TronGrid API key for higher rate limits */
  tronGridApiKey: process.env.TRONGRID_API_KEY ?? "",
  /** Minimum confirmations before accepting a payment (Nile is fast; 1 is usually enough) */
  minConfirmations: num(process.env.MIN_CONFIRMATIONS, 1),
  /** Default settlement: USDT TRC20 reads as “real commerce” on TRON; TRX for simplest faucet */
  paymentAsset: (process.env.PAYMENT_ASSET ?? "USDT").toUpperCase(),
  /** Nile USDT TRC-20 — default matches nileex.io faucet USDT token address */
  usdtContractAddress:
    process.env.TRON_NILE_USDT_CONTRACT ??
    "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
  /** Premium quote — TRX in SUN */
  pricePremiumTrxSun: num(process.env.PRICE_PREMIUM_TRX_SUN, 1_000_000),
  /** Premium quote — USDT minimal units (6 decimals, e.g. 1 USDT = 1_000_000) */
  pricePremiumUsdtMinUnits: big(process.env.PRICE_PREMIUM_USDT_UNITS, 1_000_000n),
  /** Market depth — TRX in SUN */
  priceDepthTrxSun: num(process.env.PRICE_DEPTH_TRX_SUN, 500_000),
  /** Market depth — USDT minimal units */
  priceDepthUsdtMinUnits: big(process.env.PRICE_DEPTH_USDT_UNITS, 500_000n),
  /** Access token / JWT receipt TTL (seconds) */
  accessTokenTtlSec: num(process.env.ACCESS_TOKEN_TTL_SEC, 3600),
  /** SQLite path — absolute, or relative to monorepo root */
  databasePath: (() => {
    const raw = process.env.DATABASE_PATH;
    if (!raw) return path.join(monorepoRoot, "data", "commerce.db");
    return path.isAbsolute(raw) ? raw : path.join(monorepoRoot, raw);
  })(),
  /** Comma-separated Base58 addresses allowed as payers (empty = any) */
  allowedPayerAddresses: (process.env.ALLOWED_PAYER_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Smart contract addresses (deployed via contracts/deploy.ts) */
  escrowContractAddress: process.env.ESCROW_CONTRACT_ADDRESS ?? "",
  agentRegistryContractAddress: process.env.AGENT_REGISTRY_CONTRACT_ADDRESS ?? "",
  /** Gateway private key for arbitrator/owner contract calls */
  gatewayPrivateKey: process.env.GATEWAY_PRIVATE_KEY ?? "",
  /** Simple API key for admin endpoints (reputation, resolve, onboard). Empty = no auth required (dev mode). */
  adminApiKey: process.env.ADMIN_API_KEY ?? "",
};

export function assertMerchantConfigured(): void {
  if (!config.merchantAddress) {
    throw new Error(
      "MERCHANT_TRON_ADDRESS is not set. Set it to your Nile merchant wallet (Base58)."
    );
  }
}

/**
 * Verify admin API key for privileged endpoints.
 * Returns true if auth passes, false otherwise. When adminApiKey is empty (dev mode), always passes.
 */
export function checkAdminAuth(authHeader: string | undefined): boolean {
  if (!config.adminApiKey) return true; // dev mode — no auth required
  return authHeader === `Bearer ${config.adminApiKey}`;
}

export function assertReceiptSecretForProd(): void {
  if (process.env.NODE_ENV === "production") {
    const hasPrivate = Boolean(process.env.RECEIPT_PRIVATE_KEY_PEM?.trim());
    const hasPublic = Boolean(process.env.RECEIPT_PUBLIC_KEY_PEM?.trim());
    if (!hasPrivate || !hasPublic) {
      throw new Error("Set RECEIPT_PRIVATE_KEY_PEM and RECEIPT_PUBLIC_KEY_PEM for production.");
    }
  }
}
