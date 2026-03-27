export type PaymentRequired = {
  x402Version: 1;
  scheme: "tron-settlement";
  network: string;
  resource: string;
  amount: string;
  amountAsset: "TRX" | "USDT";
  recipient: string;
  nonce: string;
  idempotencyKey?: string;
  explorerTxTemplate?: string;
  productName?: string;
};

export type RegistryService = {
  id: string;
  path: string;
  productName: string;
  description: string;
  category: string;
  returns: string;
  merchant: {
    id: string;
    name: string;
    address: string;
  };
  price: {
    asset: "TRX" | "USDT";
    amount: string;
    humanReadable: string;
  };
  payment: {
    scheme: string;
    network: string;
    recipient: string;
    usdtContract?: string;
  };
};

export type RegistryResponse = {
  gateway: string;
  network: string;
  paymentScheme: string;
  x402Compatible: boolean;
  marketplace?: boolean;
  merchants?: Array<{ id: string; name: string; address: string }>;
  services: RegistryService[];
};

export type Error402Body = {
  error: string;
  message: string;
  paymentRequired?: PaymentRequired;
};

const apiBase = "";

export const RESOURCE = {
  premium: "/v1/agent/premium-quote",
  depth: "/v1/agent/market-depth",
} as const;

export type ResourceKey = keyof typeof RESOURCE;

export async function fetchPaidResource(
  resourcePath: string,
  opts: {
    accessToken?: string;
    paymentNonce?: string;
    paymentTxId?: string;
    idempotencyKey?: string;
  }
): Promise<{
  status: number;
  json: unknown;
}> {
  const headers: Record<string, string> = {};
  if (opts.accessToken) {
    headers.Authorization = `Bearer ${opts.accessToken}`;
  }
  if (opts.paymentNonce) {
    headers["X-Payment-Nonce"] = opts.paymentNonce;
  }
  if (opts.paymentTxId) {
    headers["X-Payment-Tx-Id"] = opts.paymentTxId;
  }
  if (opts.idempotencyKey) {
    headers["Idempotency-Key"] = opts.idempotencyKey;
  }

  const res = await fetch(`${apiBase}${resourcePath}`, { headers });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

export async function fetchMerchantStatus(): Promise<unknown> {
  const res = await fetch(`${apiBase}/v1/merchant/status`);
  return res.json();
}

export async function fetchRegistry(): Promise<RegistryResponse> {
  const res = await fetch(`${apiBase}/v1/registry`);
  return res.json();
}

export async function fetchMerchantSummary(merchantId?: string): Promise<unknown> {
  const qp = merchantId ? `?merchant=${encodeURIComponent(merchantId)}` : "";
  const res = await fetch(`${apiBase}/v1/merchant/summary${qp}`);
  return res.json();
}

export async function fetchMerchantPayments(merchantId?: string): Promise<unknown> {
  const qp = merchantId
    ? `?limit=50&merchant=${encodeURIComponent(merchantId)}`
    : "?limit=50";
  const res = await fetch(`${apiBase}/v1/merchant/payments${qp}`);
  return res.json();
}

export async function fetchMerchantStatusFor(merchantId?: string): Promise<unknown> {
  const qp = merchantId ? `?merchant=${encodeURIComponent(merchantId)}` : "";
  const res = await fetch(`${apiBase}/v1/merchant/status${qp}`);
  return res.json();
}
