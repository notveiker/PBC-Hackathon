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
  handler?: string;
  productName: string;
  description: string;
  category: string;
  returns: string;
  merchant: {
    id: string;
    name: string;
    address: string;
    trust?: {
      verificationStatus?: string;
      trustScore?: number;
      riskTier?: string;
      controls?: string[];
    };
  };
  trust?: {
    riskCategory?: string;
    safeguards?: string[];
    minVerification?: string;
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
  merchants?: Array<{
    id: string;
    name: string;
    address: string;
    trust?: {
      verificationStatus?: string;
      trustScore?: number;
      riskTier?: string;
      controls?: string[];
    };
  }>;
  services: RegistryService[];
};

export type Error402Body = {
  error: string;
  message: string;
  paymentRequired?: PaymentRequired;
};

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

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

// ── Escrow API ───────────────────────────────────────────────────────────

export async function fetchEscrowInfo(): Promise<unknown> {
  const res = await fetch(`${apiBase}/v1/escrow/info`);
  return res.json();
}

export async function recordEscrow(body: {
  serviceId: string;
  merchantAddress: string;
  amountSun: string;
  buyerAddress: string;
  createTxId: string;
  escrowId: number;
}): Promise<unknown> {
  const res = await fetch(`${apiBase}/v1/escrow/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function fetchEscrow(id: number): Promise<unknown> {
  const res = await fetch(`${apiBase}/v1/escrow/${id}`);
  return res.json();
}

export async function disputeEscrow(id: number, reason: string, disputeTxId?: string): Promise<unknown> {
  const res = await fetch(`${apiBase}/v1/escrow/${id}/dispute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason, disputeTxId }),
  });
  return res.json();
}

export async function resolveEscrow(id: number, buyerPct: number): Promise<unknown> {
  const res = await fetch(`${apiBase}/v1/escrow/${id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ buyerPct }),
  });
  return res.json();
}

export async function fetchEscrowList(filters?: { buyer?: string; merchant?: string; status?: string }): Promise<unknown> {
  const params = new URLSearchParams();
  if (filters?.buyer) params.set("buyer", filters.buyer);
  if (filters?.merchant) params.set("merchant", filters.merchant);
  if (filters?.status) params.set("status", filters.status);
  const qp = params.toString() ? `?${params}` : "";
  const res = await fetch(`${apiBase}/v1/escrow${qp}`);
  return res.json();
}

// ── Agent Registry API ───────────────────────────────────────────────────

export async function registerAgent(body: { address: string; metadataURI: string; registerTxId?: string }): Promise<unknown> {
  const res = await fetch(`${apiBase}/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function fetchAgent(address: string): Promise<unknown> {
  const res = await fetch(`${apiBase}/v1/agents/${address}`);
  return res.json();
}

export async function fetchAgentList(): Promise<unknown> {
  const res = await fetch(`${apiBase}/v1/agents`);
  return res.json();
}

// ── OPSEC API ────────────────────────────────────────────────────────────

export async function simulateTransaction(body: { to: string; amount: string; asset: "TRX" | "USDT" }): Promise<unknown> {
  const res = await fetch(`${apiBase}/v1/opsec/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function analyzeContract(address: string): Promise<unknown> {
  const res = await fetch(`${apiBase}/v1/opsec/analyze-contract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  return res.json();
}

export async function fetchSpendingReport(payer: string, sinceHours?: number): Promise<unknown> {
  const params = new URLSearchParams({ payer });
  if (sinceHours) params.set("since", String(sinceHours));
  const res = await fetch(`${apiBase}/v1/opsec/spending-report?${params}`);
  return res.json();
}
