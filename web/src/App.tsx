import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchMerchantPayments,
  fetchMerchantStatusFor,
  fetchMerchantSummary,
  fetchPaidResource,
  fetchRegistry,
  fetchEscrowList,
  fetchEscrow,
  disputeEscrow,
  resolveEscrow,
  registerAgent,
  fetchAgent,
  fetchAgentList,
  simulateTransaction,
  analyzeContract,
  fetchSpendingReport,
  type Error402Body,
  type PaymentRequired,
  type RegistryResponse,
} from "./api";
import { friendlyWalletError, getTronNetworkWarning } from "./walletErrors";

type Tab = "home" | "buyer" | "merchant" | "security" | "escrow" | "agents" | "opsec";

type TronWebLike = {
  defaultAddress: { base58: string };
  fullNode?: { host?: string };
  solidityNode?: { host?: string };
  contract: () => {
    at: (addr: string) => Promise<{
      transfer: (
        to: string,
        amount: number | string
      ) => {
        send: (opts?: { feeLimit?: number }) => Promise<{
          txid?: string;
          transaction?: { txID?: string };
        }>;
      };
    }>;
  };
  transactionBuilder: {
    sendTrx: (to: string, amount: number, from: string) => Promise<Record<string, unknown>>;
  };
  trx: {
    sign: (tx: unknown) => Promise<unknown>;
    sendRawTransaction: (
      signed: unknown
    ) => Promise<{ txid?: string; result?: boolean; transaction?: { txID?: string } }>;
  };
};

type MerchantStatusView = {
  network?: string;
  merchantAddress?: string;
  paymentAsset?: string;
  usdtContract?: string | null;
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
  catalog?: {
    totalMerchants?: number;
    totalServices?: number;
    catalogPaths?: string[];
  };
  receiptVerification?: {
    alg?: string;
    issuer?: string;
    audience?: string;
  };
};

type SummaryView = {
  totalCount?: number;
  since24h?: number;
  totalUsdtLike?: string;
  pending?: {
    totalPending?: number;
    oldestPendingAgeSec?: number | null;
  };
};

type PaymentRow = {
  txId: string;
  resource: string;
  payer: string;
  asset: string;
  amountUnits: string;
  createdAt: string;
  explorer: string;
};

type QuotePayload = {
  quote?: {
    symbol?: string;
    bid?: number;
    ask?: number;
    spreadBps?: number;
    bidQty?: number;
    askQty?: number;
    ts?: string;
  };
  depth?: {
    bids?: Array<{ px: number; sz: number }>;
    asks?: Array<{ px: number; sz: number }>;
    ts?: string;
  };
  content?: Record<string, unknown>;
  settlementReceipt?: unknown;
  verification?: {
    settlementTx?: string;
    payer?: string;
    blockNumber?: number;
  };
  data?: Record<string, unknown>;
  accessToken?: string;
};

function getTronWeb(): TronWebLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    tronWeb?: unknown;
    tronLink?: { tronWeb?: unknown };
  };
  const tw = (w.tronWeb ?? w.tronLink?.tronWeb) as TronWebLike | undefined;
  return tw ?? null;
}

function formatUsdtMinimal(units: string): string {
  const n = BigInt(units);
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

function shortAddress(value: string | undefined, size = 6): string {
  if (!value) return "n/a";
  if (value.length <= size * 2) return value;
  return `${value.slice(0, size)}…${value.slice(-size)}`;
}

function capitalize(value: string | undefined): string {
  if (!value) return "Unknown";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [selectedServicePath, setSelectedServicePath] = useState("/v1/agent/premium-quote");
  const [selectedMerchantId, setSelectedMerchantId] = useState("all");

  const [merchantInfo, setMerchantInfo] = useState<unknown>(null);
  const [summary, setSummary] = useState<unknown>(null);
  const [payments, setPayments] = useState<unknown>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const [lastStatus, setLastStatus] = useState<number | null>(null);
  const [paymentRequired, setPaymentRequired] = useState<PaymentRequired | null>(null);
  const [quote, setQuote] = useState<unknown>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [manualTxId, setManualTxId] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tronReady, setTronReady] = useState(false);
  const [networkWarning, setNetworkWarning] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState("");

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toISOString()}  ${line}`, ...prev].slice(0, 60));
  }, []);

  useEffect(() => {
    const tick = () => {
      const tw = getTronWeb();
      setTronReady(Boolean(tw));
      setNetworkWarning(getTronNetworkWarning(tw as TronWebLike | null));
      setWalletAddress(tw?.defaultAddress?.base58 ?? "");
    };
    tick();
    const interval = window.setInterval(tick, 800);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    fetchRegistry()
      .then((data) => {
        setRegistry(data);
        if (!data.services.some((service) => service.path === selectedServicePath) && data.services[0]) {
          setSelectedServicePath(data.services[0].path);
        }
      })
      .catch(() => undefined);
    fetchMerchantStatusFor().then(setMerchantInfo).catch(() => undefined);
    fetchMerchantSummary().then(setSummary).catch(() => undefined);
  }, [selectedServicePath]);

  const loadMerchant = useCallback(() => {
    const merchantId = selectedMerchantId === "all" ? undefined : selectedMerchantId;
    fetchMerchantStatusFor(merchantId).then(setMerchantInfo).catch(() => undefined);
    fetchMerchantSummary(merchantId).then(setSummary).catch(() => undefined);
    fetchMerchantPayments(merchantId).then(setPayments).catch(() => undefined);
  }, [selectedMerchantId]);

  useEffect(() => {
    if (tab === "merchant") loadMerchant();
    if (tab === "buyer") {
      fetchMerchantStatusFor().then(setMerchantInfo).catch(() => undefined);
    }
  }, [tab, loadMerchant]);

  const formatApiFailure = (status: number, json: unknown): string => {
    const o = json as { message?: string; hint?: string; error?: string };
    const parts = [`HTTP ${status}`, o.error, o.message, o.hint ? `Hint: ${o.hint}` : null].filter(Boolean);
    return parts.join(" — ");
  };

  const resetFlow = () => {
    setPaymentRequired(null);
    setQuote(null);
    setAccessToken(null);
    setManualTxId("");
    setLastStatus(null);
    setError(null);
  };

  const stepRequest402 = async () => {
    setError(null);
    pushLog(`GET ${selectedServicePath} (expect 402)`);
    const { status, json } = await fetchPaidResource(selectedServicePath, { idempotencyKey });
    setLastStatus(status);
    if (status === 402) {
      const body = json as Error402Body;
      if (body.paymentRequired) {
        setPaymentRequired(body.paymentRequired);
        setQuote(null);
        pushLog(`402 Payment Required received; nonce=${body.paymentRequired.nonce}`);
        return;
      }
    }
    setError(formatApiFailure(status, json));
    pushLog(`Unexpected HTTP ${status} ${JSON.stringify(json)}`);
  };

  const broadcastResultTxid = (sent: {
    txid?: string;
    transaction?: { txID?: string };
  }): string | undefined => sent.txid ?? sent.transaction?.txID;

  const stepPayTrx = async () => {
    setError(null);
    if (!paymentRequired) {
      setError("Request a quote first.");
      return;
    }
    const tw = getTronWeb();
    if (!tw) {
      setError("TronLink not detected. Install TronLink and switch to Nile.");
      return;
    }
    if (paymentRequired.amountAsset !== "TRX") {
      setError("This payment session expects TRX.");
      return;
    }
    const from = tw.defaultAddress?.base58;
    if (!from) {
      setError("Unlock TronLink and select an account.");
      return;
    }
    try {
      const tx = await tw.transactionBuilder.sendTrx(
        paymentRequired.recipient,
        Number(paymentRequired.amount),
        from
      );
      const signed = await tw.trx.sign(tx);
      const sent = await tw.trx.sendRawTransaction(signed);
      const txid = broadcastResultTxid(sent);
      if (!txid) {
        setError("No txid returned from the TRX transfer.");
        return;
      }
      setManualTxId(txid);
      pushLog(`TRX payment broadcast: ${txid}`);
    } catch (err) {
      setError(friendlyWalletError(err));
      pushLog(String(err));
    }
  };

  const stepPayUsdt = async () => {
    setError(null);
    if (!paymentRequired) {
      setError("Request a quote first.");
      return;
    }
    if (paymentRequired.amountAsset !== "USDT") {
      setError("This payment session is not a USDT payment.");
      return;
    }
    const tw = getTronWeb();
    if (!tw?.contract) {
      setError("TronLink contract API unavailable.");
      return;
    }
    const info = merchantInfo as MerchantStatusView | null;
    const contractAddr = info?.usdtContract;
    if (!contractAddr) {
      setError("USDT contract not loaded from merchant status.");
      return;
    }
    try {
      const inst = await tw.contract().at(contractAddr);
      const sent = await inst.transfer(paymentRequired.recipient, paymentRequired.amount).send({
        feeLimit: 150_000_000,
      });
      const txid = broadcastResultTxid(sent);
      if (!txid) {
        setError("No txid returned from the USDT transfer.");
        return;
      }
      setManualTxId(txid);
      pushLog(`USDT payment broadcast: ${txid}`);
    } catch (err) {
      setError(friendlyWalletError(err));
      pushLog(String(err));
    }
  };

  const stepVerifyPayment = async () => {
    setError(null);
    if (!paymentRequired || !manualTxId.trim()) {
      setError("You need both a nonce and a Nile txid.");
      return;
    }
    pushLog(`Retry GET ${selectedServicePath} with payment proof`);
    const { status, json } = await fetchPaidResource(selectedServicePath, {
      paymentNonce: paymentRequired.nonce,
      paymentTxId: manualTxId.trim(),
      idempotencyKey,
    });
    setLastStatus(status);
    if (status === 200) {
      const body = json as { accessToken?: string };
      if (body.accessToken) setAccessToken(body.accessToken);
      setQuote(json);
      setPaymentRequired(null);
      pushLog("Verification passed; settlement receipt issued.");
      loadMerchant();
      return;
    }
    setError(formatApiFailure(status, json));
    pushLog(JSON.stringify(json));
  };

  const stepSessionFetch = async () => {
    setError(null);
    if (!accessToken) {
      setError("Complete payment first.");
      return;
    }
    pushLog(`GET ${selectedServicePath} with Bearer receipt`);
    const { status, json } = await fetchPaidResource(selectedServicePath, { accessToken });
    setLastStatus(status);
    if (status === 200) {
      setQuote(json);
      pushLog("Session fetch succeeded.");
      return;
    }
    setError(formatApiFailure(status, json));
  };

  const services = useMemo(() => registry?.services ?? [], [registry]);
  const merchants = useMemo(() => registry?.merchants ?? [], [registry]);
  const selectedService = useMemo(
    () => services.find((service) => service.path === selectedServicePath) ?? services[0] ?? null,
    [selectedServicePath, services]
  );

  const merchantStatusView = useMemo(
    () => ((merchantInfo as MerchantStatusView | null) ?? null),
    [merchantInfo]
  );
  const summaryView = useMemo(() => ((summary as SummaryView | null) ?? null), [summary]);
  const paymentRows = useMemo(() => {
    const view = payments as { rows?: PaymentRow[] } | undefined;
    return view?.rows ?? [];
  }, [payments]);

  const quoteView = quote as QuotePayload | null;
  const explorerUrl = manualTxId ? `https://nile.tronscan.org/#/transaction/${manualTxId}` : null;
  const serviceControls = selectedService?.trust?.safeguards ?? [];
  const buyerChecklist = [
    {
      label: "Wallet",
      value: tronReady ? "Connected" : "Not detected",
      tone: tronReady ? "ok" : "warn",
      detail: networkWarning ?? "TronLink available and ready for Nile testnet.",
    },
    {
      label: "Proof",
      value: paymentRequired ? "Quote issued" : accessToken ? "Receipt issued" : "Idle",
      tone: accessToken ? "ok" : paymentRequired ? "warn" : "neutral",
      detail: paymentRequired
        ? `Nonce ${shortAddress(paymentRequired.nonce, 8)} is active for this request.`
        : accessToken
          ? "A signed ES256 settlement receipt is available for session reuse."
          : "Start by requesting a 402 quote.",
    },
    {
      label: "Merchant",
      value: selectedService ? capitalize(selectedService.merchant.trust?.verificationStatus) : "Unknown",
      tone: selectedService?.merchant.trust?.verificationStatus === "verified" ? "ok" : "warn",
      detail: selectedService
        ? `${selectedService.merchant.name} scores ${selectedService.merchant.trust?.trustScore ?? "n/a"} on the trust profile.`
        : "Select a service to inspect merchant trust.",
    },
  ] as const;

const protocolSteps = [
  {
    step: "01",
    title: "Browse",
    text: "Apps and agents discover live services, prices, merchant profiles, and trust metadata from one signed registry.",
  },
  {
    step: "02",
    title: "Quote",
    text: "Any paid endpoint responds with a machine-readable 402 quote containing amount, recipient, nonce, and settlement network.",
  },
  {
    step: "03",
    title: "Pay",
    text: "The buyer settles with TRX or USDT on TRON Nile, while agent policy checks stop mismatched or unsafe requests.",
  },
  {
    step: "04",
    title: "Unlock",
    text: "The service verifies the chain payment, returns the purchased payload, and issues a reusable signed receipt.",
  },
];

  const renderPayloadInsight = () => {
    if (!quoteView) {
      return (
        <div className="empty-state">
          <strong>No unlocked payload yet</strong>
          <p>Run the buyer flow to see live quote, depth, or static content payloads here.</p>
        </div>
      );
    }

    if (quoteView.quote) {
      return (
        <div className="payload-grid">
          <div className="metric-card">
            <span>Bid</span>
            <strong>{quoteView.quote.bid?.toFixed(6) ?? "n/a"}</strong>
          </div>
          <div className="metric-card">
            <span>Ask</span>
            <strong>{quoteView.quote.ask?.toFixed(6) ?? "n/a"}</strong>
          </div>
          <div className="metric-card">
            <span>Spread</span>
            <strong>{quoteView.quote.spreadBps?.toFixed(2) ?? "n/a"} bps</strong>
          </div>
          <div className="metric-card">
            <span>Top size</span>
            <strong>
              {Math.round((quoteView.quote.bidQty ?? 0) + (quoteView.quote.askQty ?? 0)).toLocaleString()}
            </strong>
          </div>
        </div>
      );
    }

    if (quoteView.depth) {
      const totalBid = (quoteView.depth.bids ?? []).reduce((sum, level) => sum + level.sz, 0);
      const totalAsk = (quoteView.depth.asks ?? []).reduce((sum, level) => sum + level.sz, 0);
      return (
        <div className="payload-grid">
          <div className="metric-card">
            <span>Total bid depth</span>
            <strong>{Math.round(totalBid).toLocaleString()}</strong>
          </div>
          <div className="metric-card">
            <span>Total ask depth</span>
            <strong>{Math.round(totalAsk).toLocaleString()}</strong>
          </div>
          <div className="metric-card">
            <span>Bid levels</span>
            <strong>{quoteView.depth.bids?.length ?? 0}</strong>
          </div>
          <div className="metric-card">
            <span>Ask levels</span>
            <strong>{quoteView.depth.asks?.length ?? 0}</strong>
          </div>
        </div>
      );
    }

    if (quoteView.data?.content && typeof quoteView.data.content === "object") {
      return <pre className="pre mono">{JSON.stringify(quoteView.data.content, null, 2)}</pre>;
    }

    return <pre className="pre mono">{JSON.stringify(quoteView, null, 2)}</pre>;
  };

  return (
    <div className="shell">
      <div className="backdrop backdrop-one" />
      <div className="backdrop backdrop-two" />
      <main className="layout">
        <section className="hero-panel">
          <div className="hero-copy">
            <p className="eyebrow">TRON x402 commerce rail</p>
            <h1>Buy API access the way software actually works.</h1>
            <p className="lede">
              Built around one concrete job: an AI trading or analytics agent buying premium market
              data on demand. Discover paid services, verify who you are buying from, settle on
              TRON, and reuse access with signed receipts.
            </p>
            <div className="hero-actions">
              <button type="button" className="primary" onClick={() => setTab("buyer")}>
                Start buying
              </button>
              <button type="button" className="secondary" onClick={() => setTab("merchant")}>
                Sell a service
              </button>
            </div>
          </div>

          <div className="hero-aside">
            <div className="signal-card">
              <span className="signal-label">Marketplace status</span>
              <strong>{registry?.x402Compatible ? "Live payments enabled" : "Loading"}</strong>
              <p>Multi-merchant service discovery with direct settlement and reusable access receipts.</p>
            </div>
            <div className="hero-metrics">
              <div className="metric-card">
                <span>Services</span>
                <strong>{services.length}</strong>
              </div>
              <div className="metric-card">
                <span>Merchants</span>
                <strong>{merchants.length}</strong>
              </div>
              <div className="metric-card">
                <span>Purchases</span>
                <strong>{summaryView?.totalCount ?? 0}</strong>
              </div>
              <div className="metric-card">
                <span>Settlement</span>
                <strong>{merchantStatusView?.paymentAsset ?? "USDT"}</strong>
              </div>
            </div>
          </div>
        </section>

        <div className="tab-bar" role="tablist" aria-label="Application views">
          <button type="button" className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}>
            Marketplace
          </button>
          <button type="button" className={tab === "buyer" ? "active" : ""} onClick={() => setTab("buyer")}>
            Buy
          </button>
          <button type="button" className={tab === "merchant" ? "active" : ""} onClick={() => setTab("merchant")}>
            Sell
          </button>
          <button type="button" className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}>
            Trust
          </button>
          <button type="button" className={tab === "escrow" ? "active" : ""} onClick={() => setTab("escrow")}>
            Escrow
          </button>
          <button type="button" className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>
            Agents
          </button>
          <button type="button" className={tab === "opsec" ? "active" : ""} onClick={() => setTab("opsec")}>
            OPSEC
          </button>
          <a className="tab-link" href="/openapi.json" target="_blank" rel="noreferrer">
            OpenAPI
          </a>
        </div>

        {tab === "home" && (
          <div className="stack">
            <section className="panel panel-accent">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">How it works</p>
                  <h2>One payment surface for buyers, apps, and agents</h2>
                </div>
                <p className="section-copy">
                  Instead of custom integrations or one-off transfers, services expose a consistent
                  way to discover offers, pay, verify settlement, and keep durable access.
                </p>
              </div>
              <div className="flow-grid">
                {protocolSteps.map((item) => (
                  <article className="flow-step" key={item.step}>
                    <span className="step-index">{item.step}</span>
                    <h3>{item.title}</h3>
                    <p>{item.text}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Available now</p>
                  <h2>Browse live services</h2>
                </div>
                <p className="section-copy">
                  This marketplace is registry-driven, so new merchants and services can appear
                  without rewriting the frontend every time the catalog changes.
                </p>
              </div>
              <div className="service-grid">
                {services.map((service) => (
                  <article className={`service-card ${selectedService?.id === service.id ? "service-card-active" : ""}`} key={service.id}>
                    <div className="service-card-top">
                      <span className="badge badge-neutral">{service.category}</span>
                      <span className={`badge ${service.merchant.trust?.verificationStatus === "verified" ? "badge-ok" : "badge-warn"}`}>
                        {capitalize(service.merchant.trust?.verificationStatus)}
                      </span>
                    </div>
                    <h3>{service.productName}</h3>
                    <p>{service.description}</p>
                    <div className="service-meta">
                      <div>
                        <span>Merchant</span>
                        <strong>{service.merchant.name}</strong>
                      </div>
                      <div>
                        <span>Price</span>
                        <strong>{service.price.humanReadable}</strong>
                      </div>
                      <div>
                        <span>Handler</span>
                        <strong>{service.handler ?? "n/a"}</strong>
                      </div>
                      <div>
                        <span>Trust score</span>
                        <strong>{service.merchant.trust?.trustScore ?? "n/a"}</strong>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        resetFlow();
                        setSelectedServicePath(service.path);
                        setTab("buyer");
                      }}
                    >
                      Buy this service
                    </button>
                  </article>
                ))}
              </div>
            </section>

            <section className="grid-two">
              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">For buyers</p>
                    <h2>Why someone would use this</h2>
                  </div>
                </div>
                <ul className="feature-list">
                  <li>Buy once per call, not through subscriptions or manually issued API keys.</li>
                  <li>See exactly who gets paid, on which network, and for how much before you sign.</li>
                  <li>Reuse the signed receipt as session proof instead of juggling vendor-specific auth flows.</li>
                  <li>Keep a verifiable record of what was purchased and when it settled.</li>
                </ul>
              </div>

              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Primary use case</p>
                    <h2>Premium market data for autonomous trading agents</h2>
                  </div>
                </div>
                <div className="proof-list">
                  <div className="proof-item">
                    <strong>On-demand data purchases</strong>
                    <p>An agent can buy quotes or depth only when needed instead of paying for broad subscriptions.</p>
                  </div>
                  <div className="proof-item">
                    <strong>Constrained agent payments</strong>
                    <p>Before paying, the agent checks network, merchant, trust score, and spend limits.</p>
                  </div>
                  <div className="proof-item">
                    <strong>Verifiable execution</strong>
                    <p>Every purchase maps to a TRON transaction, a signed receipt, and a merchant ledger row.</p>
                  </div>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Built for real usage</p>
                  <h2>More than a single narrow demo</h2>
                </div>
                <p className="section-copy">
                  The same payment and receipt flow can gate market data, research briefs, analytics,
                  or any fixed-shape API response. The product surface is the marketplace, not one SKU.
                </p>
              </div>
              <div className="flow-grid compact">
                <article className="flow-step">
                  <h3>Apps</h3>
                  <p>Frontend clients can request and unlock paid responses without custom merchant integrations.</p>
                </article>
                <article className="flow-step">
                  <h3>Agents</h3>
                  <p>Autonomous agents can discover services, enforce policy, and pay safely with constrained hot keys.</p>
                </article>
                <article className="flow-step">
                  <h3>Merchants</h3>
                  <p>Providers publish priced endpoints, expose trust metadata, and receive direct settlement on TRON.</p>
                </article>
                <article className="flow-step">
                  <h3>Operators</h3>
                  <p>Receipts, ledger rows, and risk events make the system auditable without hiding behind screenshots.</p>
                </article>
              </div>
            </section>
          </div>
        )}

        {tab === "buyer" && (
          <div className="grid-two buyer-grid">
            <section className="panel">
              <div className="section-heading compact">
                <div>
                  <p className="eyebrow">Checkout</p>
                  <h2>Pick a service and unlock it</h2>
                </div>
              </div>

              <div className="service-picker">
                <label htmlFor="service-select">Service</label>
                <select
                  id="service-select"
                  className="select"
                  value={selectedService?.path ?? ""}
                  onChange={(event) => {
                    resetFlow();
                    setSelectedServicePath(event.target.value);
                  }}
                >
                  {services.map((service) => (
                    <option key={service.path} value={service.path}>
                      {service.productName} · {service.price.humanReadable}
                    </option>
                  ))}
                </select>
              </div>

              {selectedService && (
                <div className="service-summary">
                  <div>
                    <span>Merchant</span>
                    <strong>{selectedService.merchant.name}</strong>
                  </div>
                  <div>
                    <span>Recipient</span>
                    <strong className="mono">{shortAddress(selectedService.payment.recipient, 8)}</strong>
                  </div>
                  <div>
                    <span>Price</span>
                    <strong>{selectedService.price.humanReadable}</strong>
                  </div>
                  <div>
                    <span>Controls</span>
                    <strong>{serviceControls.length}</strong>
                  </div>
                </div>
              )}

              <div className="action-stack">
                <div className="action-card">
                  <div>
                    <span className="step-index">1</span>
                    <h3>Request the priced resource</h3>
                  </div>
                  <p>Fetch the endpoint and capture the HTTP 402 quote with nonce, amount, and recipient.</p>
                  <button type="button" className="primary" onClick={stepRequest402}>
                    Request 402 quote
                  </button>
                </div>

                {paymentRequired && (
                  <>
                    <div className="action-card">
                      <div>
                        <span className="step-index">2</span>
                        <h3>Pay on TRON Nile</h3>
                      </div>
                      <p>
                        Send <strong>{paymentRequired.amountAsset}</strong>{" "}
                        {paymentRequired.amountAsset === "USDT" ? `(~${formatUsdtMinimal(paymentRequired.amount)} USDT)` : null}
                        {" "}to <span className="mono">{shortAddress(paymentRequired.recipient, 9)}</span>.
                      </p>
                      <div className="inline-meta">
                        <span>Nonce</span>
                        <strong className="mono">{paymentRequired.nonce}</strong>
                      </div>
                      <div className="button-row">
                        {paymentRequired.amountAsset === "TRX" ? (
                          <button type="button" className="secondary" onClick={stepPayTrx}>
                            Pay with TronLink (TRX)
                          </button>
                        ) : (
                          <button type="button" className="secondary" onClick={stepPayUsdt}>
                            Pay with TronLink (USDT)
                          </button>
                        )}
                        {explorerUrl && (
                          <a className="link-button" href={explorerUrl} target="_blank" rel="noreferrer">
                            View tx
                          </a>
                        )}
                      </div>
                    </div>

                    <div className="action-card">
                      <div>
                        <span className="step-index">3</span>
                        <h3>Submit proof and unlock</h3>
                      </div>
                      <p>Paste or reuse the txid, then let the server verify it against the pending session.</p>
                      <input
                        value={manualTxId}
                        onChange={(event) => setManualTxId(event.target.value)}
                        placeholder="Paste Nile txid"
                      />
                      <div className="button-row">
                        <button type="button" className="primary" onClick={stepVerifyPayment}>
                          Verify payment
                        </button>
                        <button type="button" className="ghost" onClick={resetFlow}>
                          Reset flow
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {accessToken && (
                  <div className="action-card">
                    <div>
                      <span className="step-index">4</span>
                      <h3>Reuse the receipt as a session token</h3>
                    </div>
                    <p>The signed settlement receipt can be sent back as Bearer auth for session reuse.</p>
                    <div className="inline-meta">
                      <span>Receipt preview</span>
                      <strong className="mono">{accessToken.slice(0, 48)}…</strong>
                    </div>
                    <button type="button" className="secondary" onClick={stepSessionFetch}>
                      Fetch with Bearer receipt
                    </button>
                  </div>
                )}
              </div>

              {error && <p className="err">{error}</p>}
            </section>

            <section className="stack">
              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Readiness</p>
                    <h2>Current payment context</h2>
                  </div>
                </div>
                <div className="readiness-list">
                  {buyerChecklist.map((item) => (
                    <div className="readiness-item" key={item.label}>
                      <span className={`badge badge-${item.tone}`}>{item.value}</span>
                      <div>
                        <strong>{item.label}</strong>
                        <p>{item.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="inline-meta">
                  <span>Idempotency key</span>
                  <strong className="mono">{idempotencyKey}</strong>
                </div>
                {lastStatus !== null && (
                  <div className="inline-meta">
                    <span>Last HTTP status</span>
                    <strong>{lastStatus}</strong>
                  </div>
                )}
              </div>

              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Agent policy</p>
                    <h2>What gets checked before paying</h2>
                  </div>
                </div>
                <div className="readiness-list">
                  <div className="readiness-item">
                    <span className="badge badge-ok">TRON Nile</span>
                    <div>
                      <strong>Expected network</strong>
                      <p>Quotes must match the pinned settlement network before the agent or buyer proceeds.</p>
                    </div>
                  </div>
                  <div className="readiness-item">
                    <span className={`badge ${selectedService ? "badge-ok" : "badge-neutral"}`}>
                      {selectedService ? "Allowlisted" : "Waiting"}
                    </span>
                    <div>
                      <strong>Merchant recipient</strong>
                      <p>
                        Recipient must match the merchant address in the signed registry entry:
                        {" "}
                        <span className="mono">{selectedService ? shortAddress(selectedService.payment.recipient, 8) : "n/a"}</span>
                      </p>
                    </div>
                  </div>
                  <div className="readiness-item">
                    <span className={`badge ${selectedService ? "badge-ok" : "badge-neutral"}`}>
                      {selectedService?.price.humanReadable ?? "No quote"}
                    </span>
                    <div>
                      <strong>Spend cap</strong>
                      <p>Amounts are checked against local max-spend policy before any wallet action is taken.</p>
                    </div>
                  </div>
                  <div className="readiness-item">
                    <span className={`badge ${selectedService?.merchant.trust?.trustScore && selectedService.merchant.trust.trustScore >= 70 ? "badge-ok" : "badge-warn"}`}>
                      {selectedService?.merchant.trust?.trustScore ?? "n/a"}
                    </span>
                    <div>
                      <strong>Trust threshold</strong>
                      <p>Trust score and signed merchant manifests must clear policy before the agent pays.</p>
                    </div>
                  </div>
                </div>
                <p className="section-copy" style={{ marginTop: "0.9rem" }}>
                  Why TRON for agents? TRON’s Account Permission Management lets agent keys be restricted
                  to payment-oriented actions, reducing wallet-drain risk if a hot key is compromised.
                </p>
              </div>

              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Unlocked payload</p>
                    <h2>What the buyer actually received</h2>
                  </div>
                </div>
                {renderPayloadInsight()}
              </div>

              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Trace</p>
                    <h2>Buyer audit trail</h2>
                  </div>
                </div>
                <textarea readOnly value={log.join("\n")} />
              </div>
            </section>
          </div>
        )}

        {tab === "merchant" && (
          <div className="stack">
            <section className="grid-two">
              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Seller dashboard</p>
                    <h2>Revenue and session activity</h2>
                  </div>
                  <button type="button" className="ghost" onClick={loadMerchant}>
                    Refresh
                  </button>
                </div>
                <div className="merchant-selector">
                  <label htmlFor="merchant-select">Merchant view</label>
                  <select
                    id="merchant-select"
                    className="select"
                    value={selectedMerchantId}
                    onChange={(event) => setSelectedMerchantId(event.target.value)}
                  >
                    <option value="all">All merchants</option>
                    {merchants.map((merchant) => (
                      <option key={merchant.id} value={merchant.id}>
                        {merchant.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="hero-metrics">
                  <div className="metric-card">
                    <span>Total receipts</span>
                    <strong>{summaryView?.totalCount ?? 0}</strong>
                  </div>
                  <div className="metric-card">
                    <span>Last 24h</span>
                    <strong>{summaryView?.since24h ?? 0}</strong>
                  </div>
                  <div className="metric-card">
                    <span>USDT settled</span>
                    <strong>{summaryView?.totalUsdtLike ? `${formatUsdtMinimal(summaryView.totalUsdtLike)} USDT` : "0"}</strong>
                  </div>
                  <div className="metric-card">
                    <span>Pending sessions</span>
                    <strong>{summaryView?.pending?.totalPending ?? 0}</strong>
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Receipt profile</p>
                    <h2>Verification info</h2>
                  </div>
                </div>
                <div className="proof-list">
                  <div className="proof-item">
                    <strong>Network</strong>
                    <p>{merchantStatusView?.network ?? "tron-nile"}</p>
                  </div>
                  <div className="proof-item">
                    <strong>Settlement asset</strong>
                    <p>{merchantStatusView?.paymentAsset ?? "USDT"}</p>
                  </div>
                  <div className="proof-item">
                    <strong>Issuer / audience</strong>
                    <p>
                      {merchantStatusView?.receiptVerification?.issuer ?? "tron-commerce-gateway"} /{" "}
                      {merchantStatusView?.receiptVerification?.audience ?? "agent-client"}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section className="grid-two">
              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Catalog</p>
                    <h2>Merchant status JSON</h2>
                  </div>
                </div>
                <pre className="pre mono">{JSON.stringify(merchantInfo, null, 2)}</pre>
              </div>
              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Ledger summary</p>
                    <h2>Settlement summary JSON</h2>
                  </div>
                </div>
                <pre className="pre mono">{JSON.stringify(summary, null, 2)}</pre>
              </div>
            </section>

            <section className="panel">
              <div className="section-heading compact">
                <div>
                  <p className="eyebrow">Recent proof</p>
                  <h2>Merchant settlement ledger</h2>
                </div>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Resource</th>
                      <th>Payer</th>
                      <th>Asset</th>
                      <th>Amount</th>
                      <th>Explorer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentRows.length === 0 ? (
                      <tr>
                        <td colSpan={6}>No settled payments yet. Complete one buyer flow to populate the ledger.</td>
                      </tr>
                    ) : (
                      paymentRows.map((row) => (
                        <tr key={row.txId}>
                          <td className="mono">{row.createdAt.replace("T", " ").slice(0, 19)}</td>
                          <td className="mono">{row.resource}</td>
                          <td className="mono">{shortAddress(row.payer)}</td>
                          <td>{row.asset}</td>
                          <td>{row.asset === "USDT" ? `${formatUsdtMinimal(row.amountUnits)} USDT` : row.amountUnits}</td>
                          <td>
                            <a href={row.explorer} target="_blank" rel="noreferrer">
                              View tx
                            </a>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {tab === "security" && (
          <div className="stack">
            <section className="grid-two">
              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Trust layer</p>
                    <h2>Why buyers can rely on this</h2>
                  </div>
                </div>
                <div className="flow-grid compact">
                  {[
                    {
                      title: "Agent policy checks",
                      text: "The agent validates scheme, network, merchant recipient, amount, trust score, and manifests before paying.",
                    },
                    {
                      title: "Replay protection",
                      text: "Nonce + tx uniqueness in SQLite stop the same transfer from unlocking multiple times.",
                    },
                    {
                      title: "Signed trust layer",
                      text: "Registry entries and receipts use ES256 so discovery and settlement are independently verifiable.",
                    },
                    {
                      title: "Durable recovery",
                      text: "Pending sessions survive process restarts and can still be reconciled against late confirmations.",
                    },
                  ].map((item) => (
                    <article className="flow-step" key={item.title}>
                      <h3>{item.title}</h3>
                      <p>{item.text}</p>
                    </article>
                  ))}
                </div>
              </div>

              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Merchant posture</p>
                    <h2>Verification and identity signals</h2>
                  </div>
                </div>
                <div className="proof-list">
                  {merchants.map((merchant) => (
                    <div className="proof-item" key={merchant.id}>
                      <strong>{merchant.name}</strong>
                      <p>
                        {capitalize(merchant.trust?.verificationStatus)} · trust score{" "}
                        {merchant.trust?.trustScore ?? "n/a"} · {merchant.trust?.controls?.join(", ") || "No controls listed"}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="grid-two">
              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Agent permissions</p>
                    <h2>Constrained hot-key execution</h2>
                  </div>
                </div>
                <pre className="pre mono">{[
                  "OWNER permission",
                  "  cold wallet key",
                  "  full control, kept offline",
                  "",
                  "ACTIVE permission 'agent-active'",
                  "  agent hot key",
                  "  allowed: TransferContract, TriggerSmartContract",
                  "  blocked: UpdatePermission, freeze/stake changes, governance ops",
                ].join("\n")}</pre>
              </div>

              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Product safety</p>
                    <h2>What users should see before they pay</h2>
                  </div>
                </div>
                <ul className="feature-list">
                  <li>Always show the recipient, amount, network, and tx explorer link before asking the wallet to sign.</li>
                  <li>Make trust score and verification state visible near the CTA, not buried in advanced settings.</li>
                  <li>Explain that the JWT is a settlement receipt, not just another session token.</li>
                  <li>Keep the trace log human-readable so buyers understand why a payment was accepted or refused.</li>
                </ul>
              </div>
            </section>
          </div>
        )}

        {/* ── Escrow Tab ─────────────────────────────────────────────── */}
        {tab === "escrow" && (
          <EscrowPanel walletAddress={walletAddress} />
        )}

        {/* ── Agent Identity Tab ─────────────────────────────────────── */}
        {tab === "agents" && (
          <AgentsPanel walletAddress={walletAddress} />
        )}

        {/* ── OPSEC Tab ──────────────────────────────────────────────── */}
        {tab === "opsec" && (
          <OpsecPanel walletAddress={walletAddress} />
        )}
      </main>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-panels for new tabs (kept as separate functions for clarity)
// ═══════════════════════════════════════════════════════════════════════════

function EscrowPanel({ walletAddress }: { walletAddress: string }) {
  const [escrows, setEscrows] = useState<unknown[]>([]);
  const [lookupId, setLookupId] = useState("");
  const [lookupResult, setLookupResult] = useState<unknown>(null);
  const [disputeId, setDisputeId] = useState("");
  const [disputeReason, setDisputeReason] = useState("");
  const [resolveId, setResolveId] = useState("");
  const [resolvePct, setResolvePct] = useState(50);
  const [msg, setMsg] = useState("");

  const loadEscrows = useCallback(async () => {
    try {
      const data = await fetchEscrowList(walletAddress ? { buyer: walletAddress } : undefined) as { rows?: unknown[] };
      setEscrows(data.rows ?? []);
    } catch { /* ignore */ }
  }, [walletAddress]);

  useEffect(() => { loadEscrows(); }, [loadEscrows]);

  const statusColor = (s: string) =>
    s === "created" ? "#3b82f6" : s === "disputed" ? "#f59e0b" : s === "released" ? "#10b981" : s === "resolved" ? "#8b5cf6" : "#6b7280";

  return (
    <div className="stack">
      <section>
        <div className="section-heading">
          <div>
            <p className="eyebrow">Agentic Chargeback</p>
            <h2>On-Chain Escrow & Dispute Resolution</h2>
          </div>
        </div>

        <div className="panel">
          <h3>How Escrow Works</h3>
          <ol className="feature-list">
            <li>Buyer deposits TRX into the EscrowPayment smart contract</li>
            <li>Funds are time-locked (default: 20 blocks / ~1 minute on Nile)</li>
            <li>If satisfied: merchant claims after lock expires</li>
            <li>If unhappy: buyer disputes within lock period</li>
            <li>Arbitrator (gateway) resolves disputes, splitting funds fairly</li>
          </ol>
          <p style={{ fontSize: "0.85rem", opacity: 0.7 }}>
            All state transitions emit on-chain events — fully verifiable on Nile explorer.
          </p>
        </div>

        <div className="panel" style={{ marginTop: "1rem" }}>
          <h3>Lookup Escrow</h3>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem", flexWrap: "wrap" as const }}>
            <input aria-label="Escrow ID" placeholder="Escrow ID (0, 1, 2...)" value={lookupId} onChange={(e) => setLookupId(e.target.value)} style={{ flex: 1 }} />
            <button type="button" className="primary" onClick={async () => {
              try {
                const data = await fetchEscrow(Number(lookupId));
                setLookupResult(data);
                setMsg("");
              } catch (e) { setMsg(String(e)); }
            }}>Lookup</button>
          </div>
          {lookupResult ? (
            <pre style={{ fontSize: "0.75rem", overflow: "auto", maxHeight: "16rem", background: "rgba(24,49,79,0.06)", padding: "0.75rem", borderRadius: "6px" }}>
              {JSON.stringify(lookupResult, null, 2)}
            </pre>
          ) : null}
        </div>

        <div className="panel" style={{ marginTop: "1rem" }}>
          <h3>Dispute an Escrow</h3>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" as const }}>
            <input placeholder="Escrow ID" value={disputeId} onChange={(e) => setDisputeId(e.target.value)} style={{ width: "8rem" }} />
            <input placeholder="Reason for dispute" value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} style={{ flex: 1 }} />
            <button type="button" className="secondary" onClick={async () => {
              try {
                await disputeEscrow(Number(disputeId), disputeReason);
                setMsg("Dispute filed successfully.");
                loadEscrows();
              } catch (e) { setMsg(String(e)); }
            }}>Dispute</button>
          </div>
        </div>

        <div className="panel" style={{ marginTop: "1rem" }}>
          <h3>Resolve Dispute (Arbitrator)</h3>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem", flexWrap: "wrap" as const }}>
            <input placeholder="Escrow ID" value={resolveId} onChange={(e) => setResolveId(e.target.value)} style={{ width: "8rem" }} />
            <label style={{ fontSize: "0.85rem" }}>Buyer refund %: {resolvePct}%</label>
            <input type="range" min={0} max={100} value={resolvePct} onChange={(e) => setResolvePct(Number(e.target.value))} style={{ flex: 1 }} />
            <button type="button" className="primary" onClick={async () => {
              try {
                await resolveEscrow(Number(resolveId), resolvePct);
                setMsg(`Escrow ${resolveId} resolved: ${resolvePct}% to buyer.`);
                loadEscrows();
              } catch (e) { setMsg(String(e)); }
            }}>Resolve</button>
          </div>
        </div>

        {msg && <p style={{ color: "#f59e0b", fontSize: "0.85rem", marginTop: "0.5rem" }}>{msg}</p>}

        <div className="panel" style={{ marginTop: "1rem" }}>
          <h3>Escrow History</h3>
          <button type="button" className="secondary" onClick={loadEscrows} style={{ marginBottom: "0.5rem", fontSize: "0.8rem" }}>
            Refresh
          </button>
          {escrows.length === 0 ? (
            <p style={{ fontSize: "0.85rem", opacity: 0.6 }}>No escrows found.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="table" style={{ fontSize: "0.8rem", width: "100%" }}>
                <thead>
                  <tr><th>ID</th><th>Service</th><th>Buyer</th><th>Merchant</th><th>Amount</th><th>Status</th><th>Created</th></tr>
                </thead>
                <tbody>
                  {(escrows as Array<{ escrowId: number; serviceId: string; buyer: string; merchant: string; amountSun: string; status: string; createdAt: string; explorerTx?: string }>).map((e) => (
                    <tr key={e.escrowId}>
                      <td>{e.escrowId}</td>
                      <td>{e.serviceId}</td>
                      <td title={e.buyer}>{e.buyer.slice(0, 8)}...</td>
                      <td title={e.merchant}>{e.merchant.slice(0, 8)}...</td>
                      <td>{(Number(e.amountSun) / 1e6).toFixed(2)}</td>
                      <td><span style={{ color: statusColor(e.status), fontWeight: 600 }}>{e.status}</span></td>
                      <td>{e.createdAt ? new Date(e.createdAt).toLocaleString() : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function AgentsPanel({ walletAddress }: { walletAddress: string }) {
  const [agents, setAgents] = useState<unknown[]>([]);
  const [lookupAddr, setLookupAddr] = useState("");
  const [lookupResult, setLookupResult] = useState<unknown>(null);
  const [regUri, setRegUri] = useState("");
  const [msg, setMsg] = useState("");

  const loadAgents = useCallback(async () => {
    try {
      const data = await fetchAgentList() as { agents?: unknown[] };
      setAgents(data.agents ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  const badgeColor = (b: string) =>
    b === "gold" ? "#f59e0b" : b === "silver" ? "#9ca3af" : b === "bronze" ? "#d97706" : "#ef4444";

  return (
    <div className="stack">
      <section>
        <div className="section-heading">
          <div>
            <p className="eyebrow">Discovery + Trust Beyond ERC-8004</p>
            <h2>On-Chain Agent Identity & Reputation</h2>
          </div>
        </div>

        <div className="panel">
          <h3>Register Agent Identity</h3>
          <p style={{ fontSize: "0.85rem", opacity: 0.7, marginBottom: "0.5rem" }}>
            Self-register on the AgentRegistry smart contract with a metadata URI. Your on-chain reputation will grow as you complete transactions.
          </p>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" as const }}>
            <input placeholder="Metadata URI (IPFS or HTTP)" value={regUri} onChange={(e) => setRegUri(e.target.value)} style={{ flex: 1 }} />
            <button type="button" className="primary" onClick={async () => {
              if (!walletAddress) { setMsg("Connect TronLink first."); return; }
              try {
                const result = await registerAgent({ address: walletAddress, metadataURI: regUri || `https://agent.nile/${walletAddress}` });
                setMsg(JSON.stringify(result));
                loadAgents();
              } catch (e) { setMsg(String(e)); }
            }}>Register</button>
          </div>
          {walletAddress && (
            <p style={{ fontSize: "0.8rem", opacity: 0.6 }}>Wallet: {walletAddress}</p>
          )}
        </div>

        <div className="panel" style={{ marginTop: "1rem" }}>
          <h3>Lookup Agent Profile</h3>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" as const }}>
            <input placeholder="TRON address (T...)" value={lookupAddr} onChange={(e) => setLookupAddr(e.target.value)} style={{ flex: 1 }} />
            <button type="button" className="primary" onClick={async () => {
              try {
                const data = await fetchAgent(lookupAddr);
                setLookupResult(data);
              } catch (e) { setMsg(String(e)); }
            }}>Lookup</button>
          </div>
          {lookupResult ? (
            <pre style={{ fontSize: "0.75rem", overflow: "auto", maxHeight: "16rem", background: "rgba(24,49,79,0.06)", padding: "0.75rem", borderRadius: "6px" }}>
              {JSON.stringify(lookupResult, null, 2)}
            </pre>
          ) : null}
        </div>

        {msg && <p style={{ color: "#3b82f6", fontSize: "0.85rem", marginTop: "0.5rem" }}>{msg}</p>}

        <div className="panel" style={{ marginTop: "1rem" }}>
          <h3>Registered Agents</h3>
          <button type="button" className="secondary" onClick={loadAgents} style={{ marginBottom: "0.5rem", fontSize: "0.8rem" }}>
            Refresh
          </button>
          {agents.length === 0 ? (
            <p style={{ fontSize: "0.85rem", opacity: 0.6 }}>No agents registered yet.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="table" style={{ fontSize: "0.8rem", width: "100%" }}>
                <thead>
                  <tr><th>Address</th><th>Reputation</th><th>Badge</th><th>Transactions</th><th>Registered</th></tr>
                </thead>
                <tbody>
                  {(agents as Array<{ address: string; reputation: number; badge: string; totalTransactions: number; registeredAt: string }>).map((a) => (
                    <tr key={a.address}>
                      <td title={a.address}>{a.address.slice(0, 10)}...{a.address.slice(-4)}</td>
                      <td>{a.reputation}</td>
                      <td><span style={{ color: badgeColor(a.badge), fontWeight: 700, textTransform: "uppercase" }}>{a.badge}</span></td>
                      <td>{a.totalTransactions}</td>
                      <td>{new Date(a.registeredAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function OpsecPanel({ walletAddress }: { walletAddress: string }) {
  const [simTo, setSimTo] = useState("");
  const [simAmount, setSimAmount] = useState("1000000");
  const [simAsset, setSimAsset] = useState<"TRX" | "USDT">("USDT");
  const [simResult, setSimResult] = useState<unknown>(null);
  const [analyzeAddr, setAnalyzeAddr] = useState("");
  const [analyzeResult, setAnalyzeResult] = useState<unknown>(null);
  const [spendingResult, setSpendingResult] = useState<unknown>(null);
  const [msg, setMsg] = useState("");

  return (
    <div className="stack">
      <section>
        <div className="section-heading">
          <div>
            <p className="eyebrow">OPSEC Dev Tooling</p>
            <h2>Transaction Safety & Spending Governance</h2>
          </div>
        </div>

        {/* Transaction Simulator */}
        <div className="panel">
          <h3>Transaction Simulator</h3>
          <p style={{ fontSize: "0.85rem", opacity: 0.7, marginBottom: "0.5rem" }}>
            Dry-run a payment before signing. Checks: recipient known? amount within cap? scam patterns? account active?
          </p>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
            <input aria-label="Recipient address" placeholder="Recipient (T...)" value={simTo} onChange={(e) => setSimTo(e.target.value)} style={{ flex: 2, minWidth: "200px" }} />
            <input placeholder="Amount (minimal units)" value={simAmount} onChange={(e) => setSimAmount(e.target.value)} style={{ flex: 1, minWidth: "120px" }} />
            <select value={simAsset} onChange={(e) => setSimAsset(e.target.value as "TRX" | "USDT")}>
              <option value="USDT">USDT</option>
              <option value="TRX">TRX</option>
            </select>
            <button type="button" className="primary" onClick={async () => {
              try {
                const data = await simulateTransaction({ to: simTo, amount: simAmount, asset: simAsset });
                setSimResult(data);
                setMsg("");
              } catch (e) { setMsg(String(e)); }
            }}>Simulate</button>
          </div>

          {simResult ? (() => {
            const r = simResult as { safe?: boolean; riskLevel?: string; checks?: Array<{ check: string; passed: boolean; detail?: string }>; warnings?: string[]; summary?: string };
            return (
              <div style={{ marginTop: "0.5rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <span style={{ fontSize: "1.5rem" }}>{r.safe ? "\u2705" : "\u26A0\uFE0F"}</span>
                  <strong style={{ color: r.safe ? "#10b981" : "#ef4444" }}>{r.summary}</strong>
                </div>
                {r.checks?.map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: "0.5rem", fontSize: "0.8rem", padding: "0.25rem 0" }}>
                    <span>{c.passed ? "\u2705" : "\u274C"}</span>
                    <span style={{ fontWeight: 600 }}>{c.check}</span>
                    <span style={{ opacity: 0.7 }}>{c.detail}</span>
                  </div>
                ))}
                {(r.warnings?.length ?? 0) > 0 && (
                  <div style={{ marginTop: "0.5rem", padding: "0.5rem", background: "rgba(239,68,68,0.1)", borderRadius: "4px" }}>
                    {r.warnings?.map((w, i) => <p key={i} style={{ fontSize: "0.8rem", color: "#ef4444" }}>{w}</p>)}
                  </div>
                )}
              </div>
            );
          })() : null}
        </div>

        {/* Contract Analyzer */}
        <div className="panel" style={{ marginTop: "1rem" }}>
          <h3>Contract Risk Analyzer</h3>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" as const }}>
            <input aria-label="Contract address" placeholder="Contract address (T...)" value={analyzeAddr} onChange={(e) => setAnalyzeAddr(e.target.value)} style={{ flex: 1 }} />
            <button type="button" className="primary" onClick={async () => {
              try {
                const data = await analyzeContract(analyzeAddr);
                setAnalyzeResult(data);
              } catch (e) { setMsg(String(e)); }
            }}>Analyze</button>
          </div>
          {analyzeResult ? (
            <pre style={{ fontSize: "0.75rem", overflow: "auto", maxHeight: "14rem", background: "rgba(24,49,79,0.06)", padding: "0.75rem", borderRadius: "6px" }}>
              {JSON.stringify(analyzeResult, null, 2)}
            </pre>
          ) : null}
        </div>

        {/* Spending Report */}
        <div className="panel" style={{ marginTop: "1rem" }}>
          <h3>Spending Report</h3>
          <p style={{ fontSize: "0.85rem", opacity: 0.7, marginBottom: "0.5rem" }}>
            Track agent spending against budget caps. Shows per-merchant breakdown.
          </p>
          <button type="button" className="primary" onClick={async () => {
            if (!walletAddress) { setMsg("Connect TronLink to see your spending."); return; }
            try {
              const data = await fetchSpendingReport(walletAddress);
              setSpendingResult(data);
            } catch (e) { setMsg(String(e)); }
          }} style={{ marginBottom: "0.5rem" }}>
            Load Spending Report
          </button>

          {spendingResult ? (() => {
            const r = spendingResult as {
              payer?: string; txCount?: number; totalUsdtUnits?: string; totalTrxSun?: string;
              budgetUsage?: { usdtUsedPct?: number; trxUsedPct?: number };
              merchantBreakdown?: Array<{ merchantId: string; count: number; totalUnits: string }>;
            };
            return (
              <div>
                <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
                  <div className="metric-card">
                    <span>Total Tx</span>
                    <strong>{r.txCount ?? 0}</strong>
                  </div>
                  <div className="metric-card">
                    <span>USDT Spent</span>
                    <strong>{((Number(r.totalUsdtUnits ?? 0)) / 1e6).toFixed(2)}</strong>
                  </div>
                  <div className="metric-card">
                    <span>TRX Spent</span>
                    <strong>{((Number(r.totalTrxSun ?? 0)) / 1e6).toFixed(2)}</strong>
                  </div>
                </div>

                {/* Budget bars */}
                <div style={{ marginBottom: "0.75rem" }}>
                  <p style={{ fontSize: "0.8rem", marginBottom: "0.25rem" }}>USDT Budget: {r.budgetUsage?.usdtUsedPct ?? 0}%</p>
                  <div style={{ height: "8px", background: "rgba(24,49,79,0.08)", borderRadius: "4px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(r.budgetUsage?.usdtUsedPct ?? 0, 100)}%`, background: (r.budgetUsage?.usdtUsedPct ?? 0) > 80 ? "#ef4444" : "#10b981", transition: "width 0.3s" }} />
                  </div>
                  <p style={{ fontSize: "0.8rem", marginBottom: "0.25rem", marginTop: "0.5rem" }}>TRX Budget: {r.budgetUsage?.trxUsedPct ?? 0}%</p>
                  <div style={{ height: "8px", background: "rgba(24,49,79,0.08)", borderRadius: "4px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(r.budgetUsage?.trxUsedPct ?? 0, 100)}%`, background: (r.budgetUsage?.trxUsedPct ?? 0) > 80 ? "#ef4444" : "#10b981", transition: "width 0.3s" }} />
                  </div>
                </div>

                {(r.merchantBreakdown?.length ?? 0) > 0 && (
                  <div>
                    <h4 style={{ fontSize: "0.85rem", marginBottom: "0.25rem" }}>Per-Merchant Breakdown</h4>
                    <table className="table" style={{ fontSize: "0.8rem", width: "100%" }}>
                      <thead>
                        <tr><th>Merchant</th><th>Transactions</th><th>Total (units)</th></tr>
                      </thead>
                      <tbody>
                        {r.merchantBreakdown?.map((m) => (
                          <tr key={m.merchantId}>
                            <td>{m.merchantId}</td>
                            <td>{m.count}</td>
                            <td>{m.totalUnits}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })() : null}
        </div>

        {msg && <p style={{ color: "#f59e0b", fontSize: "0.85rem", marginTop: "0.5rem" }}>{msg}</p>}
      </section>
    </div>
  );
}
