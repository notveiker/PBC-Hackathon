export type PendingPayment = {
  nonce: string;
  amountSun: bigint;
  recipientBase58: string;
  merchantId: string;
  asset: "TRX" | "USDT";
  /** USDT contract when asset is USDT */
  contractAddress?: string;
  createdAt: number;
  /** idempotency: same logical purchase key */
  idempotencyKey?: string;
};

export const PENDING_PAYMENT_TTL_MS = 1000 * 60 * 30;
