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

function humanizeKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "n/a";
  if (typeof value === "object") return "Available";
  return String(value);
}

async function copyText(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

const PATH_TO_TAB: Record<string, Tab> = {
  "/marketplace": "home", "/buy": "buyer", "/sell": "merchant",
  "/trust": "security", "/escrow": "escrow", "/agents": "agents", "/opsec": "opsec",
};
const TAB_TO_PATH: Record<Tab, string> = {
  home: "/marketplace", buyer: "/buy", merchant: "/sell",
  security: "/trust", escrow: "/escrow", agents: "/agents", opsec: "/opsec",
};
const TAB_LABELS: Record<Tab, string> = {
  home: "Marketplace", buyer: "Buy", merchant: "Sell",
  security: "Trust", escrow: "Escrow", agents: "Agents", opsec: "OPSEC",
};

export function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof document !== "undefined") {
      return (document.documentElement.getAttribute("data-theme") as "dark" | "light") ?? "dark";
    }
    return "dark";
  });

  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
  }, [theme]);

  const [isLanding, setIsLanding] = useState(() => window.location.pathname === "/");
  const [tab, setTabRaw] = useState<Tab>(() => PATH_TO_TAB[window.location.pathname] ?? "home");

  const setTab = useCallback((t: Tab) => {
    setTabRaw(t);
    setIsLanding(false);
    window.history.pushState({}, "", TAB_TO_PATH[t]);
  }, []);

  const goHome = useCallback(() => {
    setIsLanding(true);
    window.history.pushState({}, "", "/");
  }, []);

  useEffect(() => {
    const onPop = () => {
      const p = window.location.pathname;
      if (p === "/") { setIsLanding(true); }
      else { setIsLanding(false); setTabRaw(PATH_TO_TAB[p] ?? "home"); }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
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
    if (tab === "merchant") {
      loadMerchant();
      const interval = window.setInterval(loadMerchant, 4000);
      return () => window.clearInterval(interval);
    }
    if (tab === "buyer") {
      fetchMerchantStatusFor().then(setMerchantInfo).catch(() => undefined);
    }
  }, [tab, loadMerchant]);

  const formatApiFailure = (status: number, json: unknown): string => {
    const o = json as { message?: string; hint?: string; error?: string };
    const parts = [`HTTP ${status}`, o.error, o.message, o.hint ? `Hint: ${o.hint}` : null].filter(Boolean);
    return parts.join(" - ");
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
    pushLog(`Unexpected HTTP ${status}. Review the response and try again.`);
  };

  const broadcastResultTxid = (
    sent:
      | string
      | {
          txid?: string;
          txID?: string;
          result?: boolean | { txid?: string; txID?: string };
          transaction?: { txID?: string };
        }
      | undefined
  ): string | undefined => {
    if (!sent) return undefined;
    if (typeof sent === "string") return sent;
    const nestedResult =
      sent.result && typeof sent.result === "object" ? sent.result : undefined;
    return sent.txid ?? sent.txID ?? nestedResult?.txid ?? nestedResult?.txID ?? sent.transaction?.txID;
  };

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
      setError("Automatic USDT transfer is unavailable in this browser. Send the payment manually in TronLink, then paste the txid below.");
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
    pushLog(`Verification failed with HTTP ${status}.`);
  };

  const services = useMemo(() => registry?.services ?? [], [registry]);
  const merchants = useMemo(() => registry?.merchants ?? [], [registry]);
  const featuredServices = useMemo(() => services.slice(0, 3), [services]);
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
  const highlightedMerchant = selectedService?.merchant ?? merchants[0] ?? null;
  const manualPaymentFallback = paymentRequired?.amountAsset === "USDT" && !getTronWeb()?.contract;
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

const productPillars = [
  {
    title: "Live marketplace",
    text: "Discover merchants, compare services, and buy only what your software needs right now.",
  },
  {
    title: "Safe checkout",
    text: "Every purchase is pinned to a network, recipient, amount, and nonce before any wallet action happens.",
  },
  {
    title: "Operational trust",
    text: "Signed manifests, reusable receipts, escrow, and OPSEC controls turn one-off payments into a reliable product flow.",
  },
];

const audienceCards = [
  {
    title: "Trading and analytics apps",
    text: "Buy quotes, depth, and premium research on demand instead of carrying subscriptions you barely touch.",
  },
  {
    title: "Autonomous agents",
    text: "Give agents a clear payment surface with constrained policies, trust thresholds, and reusable access receipts.",
  },
  {
    title: "API merchants",
    text: "Publish paid endpoints, expose trust metadata, and receive direct TRON settlement without building a custom checkout for every buyer.",
  },
];

const productModules = [
  {
    title: "Checkout surface",
    text: "HTTP 402 quotes, receipt-backed sessions, and UCP order flows live in one buying experience.",
  },
  {
    title: "Seller console",
    text: "Merchants track settlements, receipts, and marketplace activity from a ledger that maps directly to chain state.",
  },
  {
    title: "Trust and policy",
    text: "Registry signatures, merchant profiles, constrained keys, spend caps, and OPSEC checks keep buyers out of blind-spender mode.",
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
      const entries = Object.entries(quoteView.data.content);
      return (
        <div className="detail-grid">
          {entries.map(([key, value]) => (
            <div className="detail-card" key={key}>
              <span>{humanizeKey(key)}</span>
              <strong>{displayValue(value)}</strong>
            </div>
          ))}
        </div>
      );
    }

    if (quoteView.data && typeof quoteView.data === "object") {
      const entries = Object.entries(quoteView.data);
      return (
        <div className="detail-grid">
          {entries.map(([key, value]) => (
            <div className="detail-card" key={key}>
              <span>{humanizeKey(key)}</span>
              <strong>{displayValue(value)}</strong>
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="empty-state">
        <strong>Payload received</strong>
        <p>The purchase completed successfully and the response is available to the client.</p>
      </div>
    );
  };

  if (!isLanding) {
    return (
      <div className="shell">
        <div className="backdrop backdrop-one" />
        <div className="backdrop backdrop-two" />
        <nav className="dashboard-nav">
          <button type="button" className="nav-brand" onClick={goHome}>
            <span className="nav-mark">P</span> Portico
          </button>
          <div className="nav-tabs">
            {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
          <button type="button" className="theme-toggle" onClick={toggleTheme}>
            <span className="theme-toggle-icon">{theme === "dark" ? "\u2600" : "\u263E"}</span>
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </nav>
        <main className="dashboard-content">

        {tab === "home" && (
          <div className="stack">
            <section className="panel panel-accent">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Product flow</p>
                  <h2>One buying experience from discovery to verified access</h2>
                </div>
                <p className="section-copy">
                  Portico handles the product layer around payments too: discovery, quoting,
                  settlement, reusable access, and seller-side confirmation in one surface.
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
                  <p className="eyebrow">Marketplace</p>
                  <h2>Browse live services with trust and pricing attached</h2>
                </div>
                <p className="section-copy">
                  The catalog is registry-driven, so buyers see the same product shape even as
                  merchants add new services behind the scenes.
                </p>
              </div>
              <div className="service-grid">
                {featuredServices.map((service) => (
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
                    <p className="eyebrow">Why Portico exists</p>
                    <h2>Agents and apps need commerce, not subscriptions</h2>
                  </div>
                </div>
                <ul className="feature-list">
                  <li>Buy one response at a time instead of paying for broad plans that software may barely use.</li>
                  <li>See exactly who gets paid, on which network, and for how much before anything leaves the wallet.</li>
                  <li>Reuse a signed receipt as access proof instead of juggling vendor-specific auth patterns after payment.</li>
                  <li>Keep a verifiable trail of what was purchased, how it settled, and which merchant fulfilled it.</li>
                </ul>
              </div>

              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Built for real teams</p>
                    <h2>Where Portico fits first</h2>
                  </div>
                </div>
                <div className="proof-list">
                  {audienceCards.map((card) => (
                    <div className="proof-item" key={card.title}>
                      <strong>{card.title}</strong>
                      <p>{card.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Platform surface</p>
                  <h2>The product includes the rails around the payment</h2>
                </div>
                <p className="section-copy">
                  Buyers, merchants, operators, and agents all use the same foundation, but each
                  one sees a product module built for their side of the transaction.
                </p>
              </div>
              <div className="flow-grid compact">
                {productModules.map((module) => (
                  <article className="flow-step" key={module.title}>
                    <h3>{module.title}</h3>
                    <p>{module.text}</p>
                  </article>
                ))}
              </div>
              <div className="marketplace-footnote">
                <div className="inline-meta">
                  <span>Primary merchant</span>
                  <strong>{highlightedMerchant?.name ?? "Loading"}</strong>
                </div>
                <div className="inline-meta">
                  <span>Network</span>
                  <strong>{registry?.network ?? "tron-nile"}</strong>
                </div>
                <div className="inline-meta">
                  <span>Receipts</span>
                  <strong>Signed and reusable</strong>
                </div>
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
                    <span>Trust</span>
                    <strong>{selectedService.merchant.trust?.trustScore ?? "n/a"}</strong>
                  </div>
                  <div>
                    <span>Price</span>
                    <strong>{selectedService.price.humanReadable}</strong>
                  </div>
                  <div>
                    <span>Delivery</span>
                    <strong>{selectedService.category}</strong>
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
                        {manualPaymentFallback && (
                          <button
                            type="button"
                            className="ghost"
                            onClick={async () => {
                              const amountLabel =
                                paymentRequired.amountAsset === "USDT"
                                  ? `${formatUsdtMinimal(paymentRequired.amount)} USDT`
                                  : paymentRequired.amount;
                              const ok = await copyText(
                                `Recipient: ${paymentRequired.recipient}\nAmount: ${amountLabel}`
                              );
                              pushLog(
                                ok
                                  ? "Payment details copied to clipboard."
                                  : "Copy payment details manually from the screen."
                              );
                            }}
                          >
                            Copy payment details
                          </button>
                        )}
                        {explorerUrl && !manualPaymentFallback && (
                          <a className="link-button" href={explorerUrl} target="_blank" rel="noreferrer">
                            View tx
                          </a>
                        )}
                      </div>
                      {manualPaymentFallback ? (
                        <p className="helper-copy">
                          If the TronLink token prompt does not open, send the displayed USDT amount to the shown recipient in TronLink manually, then paste the txid in step 3.
                        </p>
                      ) : null}
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
                      </div>
                    </div>
                  </>
                )}

                {accessToken && (
                  <div className="action-card">
                    <div>
                      <span className="step-index">4</span>
                      <h3>Receipt issued</h3>
                    </div>
                    <p>The payment is verified and a signed settlement receipt is now attached to this access session.</p>
                    <div className="inline-meta">
                      <span>Session status</span>
                      <strong>Unlocked and ready</strong>
                    </div>
                    {explorerUrl && (
                      <a className="link-button" href={explorerUrl} target="_blank" rel="noreferrer">
                        View settlement tx
                      </a>
                    )}
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
                    <h2>Checkout status</h2>
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
                    <h2>Safety checks before payment</h2>
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
                    <p className="eyebrow">Activity</p>
                    <h2>Recent checkout events</h2>
                  </div>
                </div>
                {log.length === 0 ? (
                  <div className="empty-state">
                    <strong>No recent events</strong>
                    <p>Start a checkout flow and key payment milestones will appear here.</p>
                  </div>
                ) : (
                  <div className="timeline-list">
                    {log.slice(0, 8).map((line) => {
                      const [stamp, ...rest] = line.split("  ");
                      return (
                        <div className="timeline-item" key={line}>
                          <span className="timeline-stamp">{stamp.replace("T", " ").slice(0, 19)}</span>
                          <p>{rest.join("  ")}</p>
                        </div>
                      );
                    })}
                  </div>
                )}
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
                    <h2>Merchant coverage</h2>
                  </div>
                </div>
                <div className="detail-grid">
                  <div className="detail-card">
                    <span>Total merchants</span>
                    <strong>{merchantStatusView?.catalog?.totalMerchants ?? merchants.length}</strong>
                  </div>
                  <div className="detail-card">
                    <span>Total services</span>
                    <strong>{merchantStatusView?.catalog?.totalServices ?? services.length}</strong>
                  </div>
                  <div className="detail-card">
                    <span>Receipt algorithm</span>
                    <strong>{merchantStatusView?.receiptVerification?.alg ?? "ES256"}</strong>
                  </div>
                  <div className="detail-card">
                    <span>Merchant address</span>
                    <strong className="mono">{shortAddress(merchantStatusView?.merchantAddress, 8)}</strong>
                  </div>
                </div>
              </div>
              <div className="panel">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">Merchant profiles</p>
                    <h2>Trust and routing</h2>
                  </div>
                </div>
                <div className="proof-list">
                  {(merchantStatusView?.merchants ?? merchants).map((merchant) => (
                    <div className="proof-item" key={merchant.id}>
                      <strong>{merchant.name}</strong>
                      <p>
                        {shortAddress(merchant.address, 8)} · {capitalize(merchant.trust?.verificationStatus)} · trust score{" "}
                        {merchant.trust?.trustScore ?? "n/a"}
                      </p>
                    </div>
                  ))}
                </div>
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
                <div className="proof-list">
                  <div className="proof-item">
                    <strong>Owner key</strong>
                    <p>Cold wallet, full control, kept offline and outside agent runtime.</p>
                  </div>
                  <div className="proof-item">
                    <strong>Agent hot key</strong>
                    <p>Limited to TransferContract and TriggerSmartContract for TRX and USDT payments.</p>
                  </div>
                  <div className="proof-item">
                    <strong>Blocked actions</strong>
                    <p>Permission updates, staking changes, governance actions, and broader wallet control stay disabled.</p>
                  </div>
                </div>
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
                  <li>Explain that the JWT is a settlement receipt and session token.</li>
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

  // ── Landing Page ──────────────────────────────────────────────────────
  return (
    <div className="shell">
      <div className="backdrop backdrop-one" />
      <div className="backdrop backdrop-two" />
      <main className="layout">
        <section className="brand-bar">
          <button type="button" className="brand-lockup" onClick={goHome}>
            <span className="brand-mark">P</span>
            <span className="brand-copy">
              <strong>Portico</strong>
              <span>Agent commerce on TRON</span>
            </span>
          </button>
          <div className="brand-meta">
            <span>TRON Nile</span>
            <span>402 + UCP</span>
            <span>Escrow + OPSEC</span>
            <button type="button" className="theme-toggle" onClick={toggleTheme}>
              <span className="theme-toggle-icon">{theme === "dark" ? "\u2600" : "\u263E"}</span>
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
        </section>

        <section className="hero-panel">
          <div className="hero-grid">
            <div className="hero-copy">
              <p className="eyebrow">Portico</p>
              <h1>Turn paid APIs into something software can actually buy.</h1>
              <p className="lede">
                Portico is a commerce layer for paid API access on TRON. Buyers discover services,
                receive a machine-readable payment quote, settle on-chain, and unlock access with
                signed receipts that work across product sessions.
              </p>
              <div className="hero-actions">
                <button type="button" className="primary" onClick={() => setTab("buyer")}>
                  Launch checkout
                </button>
                <button type="button" className="secondary" onClick={() => setTab("home")}>
                  Browse marketplace
                </button>
              </div>
              <div className="hero-pillar-row">
                {productPillars.map((pillar) => (
                  <article className="pillar-card" key={pillar.title}>
                    <strong>{pillar.title}</strong>
                    <p>{pillar.text}</p>
                  </article>
                ))}
              </div>
            </div>

            <div className="hero-aside">
              <div className="signal-card signal-card-featured">
                <span className="signal-label">Featured service</span>
                <strong>{selectedService?.productName ?? "Loading marketplace"}</strong>
                <p>
                  {selectedService?.description ??
                    "Registry-backed service discovery, payment quotes, and reusable access receipts."}
                </p>
                <div className="signal-stats">
                  <div>
                    <span>Price</span>
                    <strong>{selectedService?.price.humanReadable ?? "..."}</strong>
                  </div>
                  <div>
                    <span>Merchant</span>
                    <strong>{selectedService?.merchant.name ?? "..."}</strong>
                  </div>
                  <div>
                    <span>Trust</span>
                    <strong>{selectedService?.merchant.trust?.trustScore ?? "..."}</strong>
                  </div>
                </div>
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
          </div>
        </section>
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
            All state transitions emit on-chain events - fully verifiable on Nile explorer.
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
          {lookupResult ? (() => {
            const escrow = lookupResult as {
              escrowId?: number;
              onChain?: { status?: string; buyer?: string; merchant?: string; amount?: string; serviceId?: string };
              local?: { status?: string; createdAt?: string; disputeReason?: string; buyerPct?: number };
              explorerContract?: string | null;
            };
            return (
              <div className="detail-grid">
                <div className="detail-card">
                  <span>Status</span>
                  <strong>{capitalize(escrow.local?.status ?? escrow.onChain?.status)}</strong>
                </div>
                <div className="detail-card">
                  <span>Service</span>
                  <strong>{escrow.onChain?.serviceId ?? "n/a"}</strong>
                </div>
                <div className="detail-card">
                  <span>Buyer</span>
                  <strong className="mono">{shortAddress(escrow.onChain?.buyer, 8)}</strong>
                </div>
                <div className="detail-card">
                  <span>Merchant</span>
                  <strong className="mono">{shortAddress(escrow.onChain?.merchant, 8)}</strong>
                </div>
                <div className="detail-card">
                  <span>Amount</span>
                  <strong>{escrow.onChain?.amount ? `${(Number(escrow.onChain.amount) / 1e6).toFixed(2)} TRX` : "n/a"}</strong>
                </div>
                <div className="detail-card">
                  <span>Created</span>
                  <strong>{escrow.local?.createdAt ? new Date(escrow.local.createdAt).toLocaleString() : "n/a"}</strong>
                </div>
                {escrow.local?.disputeReason ? (
                  <div className="detail-card detail-card-wide">
                    <span>Dispute reason</span>
                    <strong>{escrow.local.disputeReason}</strong>
                  </div>
                ) : null}
                {typeof escrow.local?.buyerPct === "number" ? (
                  <div className="detail-card">
                    <span>Buyer resolution</span>
                    <strong>{escrow.local.buyerPct}%</strong>
                  </div>
                ) : null}
                {escrow.explorerContract ? (
                  <div className="detail-card">
                    <span>Explorer</span>
                    <strong><a href={escrow.explorerContract} target="_blank" rel="noreferrer">View contract</a></strong>
                  </div>
                ) : null}
              </div>
            );
          })() : null}
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
                await registerAgent({ address: walletAddress, metadataURI: regUri || `https://agent.nile/${walletAddress}` });
                setMsg("Agent registered successfully.");
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
          {lookupResult ? (() => {
            const agent = lookupResult as {
              badge?: string;
              onChain?: { reputation?: number; totalTransactions?: number; metadataURI?: string };
              local?: { reputation?: number; totalTransactions?: number; registeredAt?: string; metadataUri?: string };
              explorerUrl?: string;
            };
            return (
              <div className="detail-grid">
                <div className="detail-card">
                  <span>Badge</span>
                  <strong>{capitalize(agent.badge)}</strong>
                </div>
                <div className="detail-card">
                  <span>Reputation</span>
                  <strong>{agent.onChain?.reputation ?? agent.local?.reputation ?? 0}</strong>
                </div>
                <div className="detail-card">
                  <span>Transactions</span>
                  <strong>{agent.onChain?.totalTransactions ?? agent.local?.totalTransactions ?? 0}</strong>
                </div>
                <div className="detail-card">
                  <span>Registered</span>
                  <strong>{agent.local?.registeredAt ? new Date(agent.local.registeredAt).toLocaleString() : "On-chain"}</strong>
                </div>
                <div className="detail-card detail-card-wide">
                  <span>Metadata</span>
                  <strong>{agent.onChain?.metadataURI ?? agent.local?.metadataUri ?? "n/a"}</strong>
                </div>
                {agent.explorerUrl ? (
                  <div className="detail-card">
                    <span>Explorer</span>
                    <strong><a href={agent.explorerUrl} target="_blank" rel="noreferrer">View address</a></strong>
                  </div>
                ) : null}
              </div>
            );
          })() : null}
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
          {analyzeResult ? (() => {
            const r = analyzeResult as {
              isContract?: boolean;
              hasCode?: boolean;
              knownToken?: string | null;
              contractName?: string | null;
              riskLevel?: string;
              warnings?: string[];
              explorerUrl?: string;
            };
            return (
              <div className="detail-grid">
                <div className="detail-card">
                  <span>Risk level</span>
                  <strong>{capitalize(r.riskLevel)}</strong>
                </div>
                <div className="detail-card">
                  <span>Contract detected</span>
                  <strong>{displayValue(r.isContract)}</strong>
                </div>
                <div className="detail-card">
                  <span>Bytecode present</span>
                  <strong>{displayValue(r.hasCode)}</strong>
                </div>
                <div className="detail-card">
                  <span>Known token</span>
                  <strong>{r.knownToken ?? "Unknown"}</strong>
                </div>
                <div className="detail-card">
                  <span>Name</span>
                  <strong>{r.contractName ?? "Unknown"}</strong>
                </div>
                {r.explorerUrl ? (
                  <div className="detail-card">
                    <span>Explorer</span>
                    <strong><a href={r.explorerUrl} target="_blank" rel="noreferrer">View contract</a></strong>
                  </div>
                ) : null}
                {(r.warnings?.length ?? 0) > 0 ? (
                  <div className="detail-card detail-card-wide">
                    <span>Warnings</span>
                    <strong>{r.warnings?.join(" | ")}</strong>
                  </div>
                ) : null}
              </div>
            );
          })() : null}
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
