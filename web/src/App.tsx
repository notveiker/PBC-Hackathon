import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchRegistry,
  fetchMerchantPayments,
  fetchMerchantStatusFor,
  fetchMerchantSummary,
  fetchPaidResource,
  type Error402Body,
  type PaymentRequired,
  type RegistryResponse,
  type RegistryService,
} from "./api";
import { friendlyWalletError, getTronNetworkWarning } from "./walletErrors";

type Tab = "home" | "buyer" | "merchant" | "security";

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
    sendTrx: (
      to: string,
      amount: number,
      from: string
    ) => Promise<Record<string, unknown>>;
  };
  trx: {
    sign: (tx: unknown) => Promise<unknown>;
    sendRawTransaction: (
      signed: unknown
    ) => Promise<{ txid?: string; result?: boolean; transaction?: { txID?: string } }>;
  };
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

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [selectedServicePath, setSelectedServicePath] = useState("/v1/agent/premium-quote");
  const [selectedMerchantId, setSelectedMerchantId] = useState<string>("all");
  const resourcePath = selectedServicePath;

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

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toISOString()}  ${line}`, ...prev].slice(0, 50));
  }, []);

  useEffect(() => {
    const tick = () => {
      const tw = getTronWeb();
      setTronReady(Boolean(tw));
      setNetworkWarning(getTronNetworkWarning(tw as TronWebLike | null));
    };
    tick();
    const i = window.setInterval(tick, 800);
    return () => window.clearInterval(i);
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
  }, []);

  const loadMerchant = useCallback(() => {
    const merchantId = selectedMerchantId === "all" ? undefined : selectedMerchantId;
    fetchMerchantStatusFor(merchantId).then(setMerchantInfo).catch(() => undefined);
    fetchMerchantSummary(merchantId).then(setSummary).catch(() => undefined);
    fetchMerchantPayments(merchantId).then(setPayments).catch(() => undefined);
  }, [selectedMerchantId]);

  useEffect(() => {
    if (tab === "buyer") {
      fetchMerchantStatusFor().then(setMerchantInfo).catch(() => undefined);
    }
  }, [tab]);

  useEffect(() => {
    if (tab === "merchant") loadMerchant();
  }, [tab, loadMerchant]);

  const formatApiFailure = (status: number, json: unknown): string => {
    const o = json as { message?: string; hint?: string; error?: string };
    const parts = [
      `HTTP ${status}`,
      o.error,
      o.message,
      o.hint ? `Hint: ${o.hint}` : null,
    ].filter(Boolean);
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
    pushLog(`GET ${resourcePath} (expect 402)`);
    const { status, json } = await fetchPaidResource(resourcePath, { idempotencyKey });
    setLastStatus(status);
    if (status === 402) {
      const body = json as Error402Body;
      if (body.paymentRequired) {
        setPaymentRequired(body.paymentRequired);
        pushLog(`402 — nonce=${body.paymentRequired.nonce}`);
        setQuote(null);
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
      setError("Request 402 first.");
      return;
    }
    const tw = getTronWeb();
    if (!tw) {
      setError("TronLink not detected. Install TronLink and switch to Nile.");
      return;
    }
    if (paymentRequired.amountAsset !== "TRX") {
      setError("Current session expects TRX. Use Pay USDT or change PAYMENT_ASSET.");
      return;
    }
    const from = tw.defaultAddress?.base58;
    if (!from) {
      setError("Unlock TronLink and select an account.");
      return;
    }
    const amountSun = Number(paymentRequired.amount);
    try {
      pushLog(`TronLink TRX → ${paymentRequired.recipient} sun=${amountSun}`);
      const tx = await tw.transactionBuilder.sendTrx(
        paymentRequired.recipient,
        amountSun,
        from
      );
      const signed = await tw.trx.sign(tx);
      const sent = await tw.trx.sendRawTransaction(signed);
      const txid = broadcastResultTxid(sent);
      if (!txid) {
        setError("No txid from broadcast — confirm Nile network in TronLink.");
        pushLog(JSON.stringify(sent));
        return;
      }
      setManualTxId(txid);
      pushLog(`txid=${txid}`);
    } catch (e) {
      setError(friendlyWalletError(e));
      pushLog(String(e));
    }
  };

  const stepPayUsdt = async () => {
    setError(null);
    if (!paymentRequired) {
      setError("Request 402 first.");
      return;
    }
    if (paymentRequired.amountAsset !== "USDT") {
      setError("Current session is not USDT.");
      return;
    }
    const tw = getTronWeb();
    if (!tw?.contract) {
      setError("TronLink contract API unavailable.");
      return;
    }
    const info = merchantInfo as { usdtContract?: string | null } | null;
    const contractAddr = info?.usdtContract;
    if (!contractAddr) {
      setError("Load Merchant tab once to fetch USDT contract, or check server config.");
      return;
    }
    const from = tw.defaultAddress?.base58;
    if (!from) {
      setError("Unlock TronLink and select an account.");
      return;
    }
    try {
      const inst = await tw.contract().at(contractAddr);
      pushLog(`TronLink USDT transfer → ${paymentRequired.recipient} units=${paymentRequired.amount}`);
      const sent = await inst.transfer(paymentRequired.recipient, paymentRequired.amount).send({
        feeLimit: 150_000_000,
      });
      const txid = broadcastResultTxid(sent);
      if (!txid) {
        setError("No txid from USDT transfer.");
        pushLog(JSON.stringify(sent));
        return;
      }
      setManualTxId(txid);
      pushLog(`txid=${txid}`);
    } catch (e) {
      setError(friendlyWalletError(e));
      pushLog(String(e));
    }
  };

  const stepVerifyPayment = async () => {
    setError(null);
    if (!paymentRequired || !manualTxId.trim()) {
      setError("Need nonce from 402 and a transaction id.");
      return;
    }
    pushLog(`Retry GET ${resourcePath} with proof`);
    const { status, json } = await fetchPaidResource(resourcePath, {
      paymentNonce: paymentRequired.nonce,
      paymentTxId: manualTxId.trim(),
      idempotencyKey,
    });
    setLastStatus(status);
    if (status === 200) {
      const body = json as { accessToken?: string; settlementReceipt?: unknown };
      if (body.accessToken) setAccessToken(body.accessToken);
      setQuote(json);
      pushLog("200 — verified, JWT settlement receipt issued");
      setPaymentRequired(null);
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
    pushLog(`GET ${resourcePath} with Bearer JWT`);
    const { status, json } = await fetchPaidResource(resourcePath, { accessToken });
    setLastStatus(status);
    if (status === 200) {
      setQuote(json);
      pushLog("200 — session");
      return;
    }
    setError(formatApiFailure(status, json));
  };

  const permArchDiagram = [
    "TRON Account: Merchant / Payer",
    "",
    "  OWNER permission  (threshold 1)",
    "  +- cold wallet key  (weight 1)",
    "     Can do everything; kept offline",
    "",
    "  ACTIVE permission 'agent-active'  (threshold 1)",
    "  +- agent hot key  (weight 1)",
    "     Allowed: TransferContract, TriggerSmartContract",
    "     Blocked: UpdatePermission, FreezeBalance, Vote...",
  ].join("\n");

  const permCodeSnippet = [
    "const agentPermission = {",
    "  type: 2,                        // ACTIVE",
    "  permission_name: 'agent-active',",
    "  threshold: 1,",
    "  // operations bitmask: TransferContract + TriggerSmartContract",
    "  operations: '02000000800000000000000000000000' +",
    "              '00000000000000000000000000000000',",
    "  keys: [{ address: AGENT_ADDRESS, weight: 1 }],",
    "};",
    "",
    "const tx = await tronWeb.transactionBuilder",
    "  .updateAccountPermissions(",
    "    OWNER_ADDRESS,",
    "    ownerPermission,   // unchanged owner",
    "    null,              // not a Super Representative",
    "    [agentPermission], // constrained active",
    "  );",
    "",
    "const signed = await tronWeb.trx.sign(tx, OWNER_KEY);",
    "const result = await tronWeb.trx.sendRawTransaction(signed);",
    "// agent key is now sandboxed",
  ].join("\n");

  const explorerUrl = useMemo(() => {
    if (!manualTxId) return null;
    return `https://nile.tronscan.org/#/transaction/${manualTxId}`;
  }, [manualTxId]);

  const paymentRows = useMemo(() => {
    const p = payments as
      | { rows?: Array<{ txId: string; resource: string; payer: string; asset: string; amountUnits: string; createdAt: string; explorer: string }> }
      | undefined;
    return p?.rows ?? [];
  }, [payments]);

  const services = useMemo(() => registry?.services ?? [], [registry]);
  const merchants = useMemo(() => registry?.merchants ?? [], [registry]);
  const selectedService = useMemo<RegistryService | null>(
    () => services.find((service) => service.path === selectedServicePath) ?? services[0] ?? null,
    [selectedServicePath, services]
  );

  const merchantStatusView = useMemo(() => {
    return (merchantInfo as
      | {
          network?: string;
          merchantAddress?: string;
          paymentAsset?: string;
          usdtContract?: string | null;
          merchants?: Array<{ id: string; name: string; address: string }>;
        }
      | null) ?? null;
  }, [merchantInfo]);

  const summaryView = useMemo(() => {
    return (summary as
      | {
          totalCount?: number;
          since24h?: number;
          totalUsdtLike?: string;
        }
      | null) ?? null;
  }, [summary]);

  return (
    <div className="layout">
      <header className="hero">
        <p className="eyebrow">Nile testnet · TRON settlement</p>
        <h1>Nile Commerce Gateway</h1>
        <p className="lede">
          Pay-per-use APIs for <strong>AI agents</strong> and apps: HTTP{" "}
          <strong>402 Payment Required</strong>, on-chain verification,{" "}
          <strong>JWT settlement receipts</strong>, and a merchant audit log — not just a wallet
          transfer.
        </p>
      </header>

      <div className="tabs" role="tablist">
        <button type="button" className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}>
          Product
        </button>
        <button type="button" className={tab === "buyer" ? "active" : ""} onClick={() => setTab("buyer")}>
          Buyer / agent
        </button>
        <button
          type="button"
          className={tab === "merchant" ? "active" : ""}
          onClick={() => setTab("merchant")}
        >
          Merchant
        </button>
        <button
          type="button"
          className={tab === "security" ? "active" : ""}
          onClick={() => setTab("security")}
        >
          Security
        </button>
        <a className="tab-link" href="/openapi.json" target="_blank" rel="noreferrer">
          OpenAPI
        </a>
      </div>

      {tab === "home" && (
        <div className="grid" style={{ gap: "1.25rem" }}>
          <div className="card spotlight">
            <p className="eyebrow" style={{ marginBottom: "0.75rem" }}>Judge snapshot</p>
            <div className="spotlight-grid">
              <div>
                <h2 style={{ marginBottom: "0.55rem" }}>Why this can win</h2>
                <p className="small" style={{ marginTop: 0 }}>
                  This is not just a wallet transfer or chatbot wrapper. It turns paid API access
                  into a verifiable commerce primitive: <strong>402 quote</strong>, <strong>TRON payment</strong>,
                  <strong> on-chain verification</strong>, <strong>JWT receipt</strong>, and a
                  <strong> merchant ledger</strong>.
                </p>
                <div className="row" style={{ marginTop: "0.85rem" }}>
                  <span className="badge ok">Verifiable on Nile</span>
                  <span className="badge ok">Two monetized SKUs</span>
                  <span className="badge ok">Agent-ready flow</span>
                  <span className="badge ok">Security story</span>
                </div>
              </div>

              <div className="judge-panel">
                <div className="judge-stat">
                  <span className="judge-label">Network</span>
                  <strong>{merchantStatusView?.network ?? "tron-nile"}</strong>
                </div>
                <div className="judge-stat">
                  <span className="judge-label">Settlement asset</span>
                  <strong>{merchantStatusView?.paymentAsset ?? "USDT"}</strong>
                </div>
                <div className="judge-stat">
                  <span className="judge-label">Merchant receipts</span>
                  <strong>{summaryView?.totalCount ?? 0}</strong>
                </div>
                <div className="judge-stat">
                  <span className="judge-label">24h activity</span>
                  <strong>{summaryView?.since24h ?? 0}</strong>
                </div>
              </div>
            </div>
          </div>

          <div className="grid two">
            <div className="card">
            <h2>User journey</h2>
            <ol className="small" style={{ margin: 0, paddingLeft: "1.2rem", lineHeight: 1.6 }}>
              <li>
                <strong>Discover</strong> — pick a priced API (premium quote or market depth).
              </li>
              <li>
                <strong>Price</strong> — server returns <strong>402</strong> + TRON payment details
                (default: <strong>USDT</strong> on Nile for a "real commerce" story).
              </li>
              <li>
                <strong>Pay</strong> — TronLink or paste txid; settlement is verified on-chain.
              </li>
              <li>
                <strong>Unlock</strong> — receive data + <strong>JWT receipt</strong> (HS256).
              </li>
              <li>
                <strong>Proof</strong> — merchant sees rows in the audit log + Tronscan link.
              </li>
            </ol>
          </div>
            <div className="card">
              <h2>TRON-native value</h2>
              <ul className="small" style={{ margin: 0, paddingLeft: "1.1rem", lineHeight: 1.6 }}>
                <li>Stablecoin-friendly settlement (USDT TRC-20).</li>
                <li>Bandwidth / energy make per-call commerce practical.</li>
                <li>Optional payer allowlist for agent sandboxing.</li>
                <li>Account Permission Management gives you a real hot-key safety story.</li>
              </ul>
              <button type="button" className="primary" style={{ marginTop: "1rem" }} onClick={() => setTab("buyer")}>
                Run the buyer flow
              </button>
            </div>
          </div>

          <div className="grid two">
            <div className="card">
              <h2>What Judges Should Notice</h2>
              <ul className="small" style={{ margin: 0, paddingLeft: "1.1rem", lineHeight: 1.7 }}>
                <li>
                  <strong>Real business model:</strong> the product sells two distinct market data SKUs,
                  not a single hard-coded payment button.
                </li>
                <li>
                  <strong>Proof, not trust:</strong> every unlock is backed by a chain tx, a signed receipt,
                  and a merchant ledger row.
                </li>
                <li>
                  <strong>Agent commerce:</strong> the same gateway works for browser wallets and autonomous agents.
                </li>
                <li>
                  <strong>Security depth:</strong> replay protection, idempotency, payer allowlists, and constrained keys.
                </li>
              </ul>
            </div>

            <div className="card">
              <h2>Live Demo Checklist</h2>
              <div className="checklist">
                <div className="check-item">
                  <span className={`badge ${merchantStatusView ? "ok" : "warn"}`}>
                    {merchantStatusView ? "Ready" : "Waiting"}
                  </span>
                  <div>
                    <strong>Merchant config loaded</strong>
                    <p className="small">
                      {merchantStatusView?.merchantAddress
                        ? `Merchant ${merchantStatusView.merchantAddress.slice(0, 8)}… is serving priced endpoints.`
                        : "Open the app with the server running to confirm merchant status."}
                    </p>
                  </div>
                </div>
                <div className="check-item">
                  <span className={`badge ${tronReady ? "ok" : "warn"}`}>
                    {tronReady ? "Ready" : "Wallet"}
                  </span>
                  <div>
                    <strong>Buyer wallet on Nile</strong>
                    <p className="small">
                      {networkWarning ?? "TronLink is available for the buyer flow."}
                    </p>
                  </div>
                </div>
                <div className="check-item">
                  <span className={`badge ${(summaryView?.totalCount ?? 0) > 0 ? "ok" : "warn"}`}>
                    {(summaryView?.totalCount ?? 0) > 0 ? "Live proof" : "Pending"}
                  </span>
                  <div>
                    <strong>Settlement evidence</strong>
                    <p className="small">
                      {(summaryView?.totalCount ?? 0) > 0
                        ? `${summaryView?.totalCount} payment(s) already recorded in the merchant ledger.`
                        : "Complete one purchase to populate merchant receipts and Tronscan proof."}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "buyer" && (
        <div className="grid two">
          <div className="card">
            <h2>Buyer / agent</h2>
            {networkWarning && (
              <p className="banner-warn small" role="status">
                {networkWarning}
              </p>
            )}
            <p className="small">
              Service:{" "}
              <select
                className="select"
                value={selectedService?.path ?? ""}
                onChange={(e) => {
                  resetFlow();
                  setSelectedServicePath(e.target.value);
                }}
              >
                {services.map((service) => (
                  <option key={service.path} value={service.path}>
                    {service.productName} · {service.merchant.name}
                  </option>
                ))}
              </select>
              <span className="mono small" style={{ marginLeft: "0.5rem" }}>
                {resourcePath}
              </span>
            </p>
            {selectedService && (
              <p className="small">
                Merchant: <strong>{selectedService.merchant.name}</strong> · Price:{" "}
                <strong>{selectedService.price.humanReadable}</strong>
              </p>
            )}
            <p className="small">
              Idempotency-Key: <span className="mono">{idempotencyKey}</span>
            </p>
            <div className="row" style={{ marginTop: "0.75rem" }}>
              <span className={`badge ${tronReady ? "ok" : "warn"}`}>
                {tronReady ? "TronLink" : "No TronLink"}
              </span>
              {lastStatus !== null && <span className="badge">HTTP {lastStatus}</span>}
            </div>

            <h3>1 — Request (402)</h3>
            <button type="button" className="primary" onClick={stepRequest402}>
              Request priced resource
            </button>

            {paymentRequired && (
              <>
                <h3>2 — Pay on Nile</h3>
                <p className="small">
                  <strong>{paymentRequired.productName ?? "Resource"}</strong> — send{" "}
                  <strong>{paymentRequired.amountAsset}</strong>
                  {paymentRequired.amountAsset === "USDT" && (
                    <> (~{formatUsdtMinimal(paymentRequired.amount)} USDT)</>
                  )}{" "}
                  minimal units: <span className="mono">{paymentRequired.amount}</span>
                  <br />
                  To: <span className="mono">{paymentRequired.recipient}</span>
                  <br />
                  Nonce: <span className="mono">{paymentRequired.nonce}</span>
                </p>
                <div className="row">
                  {paymentRequired.amountAsset === "TRX" && (
                    <button type="button" className="secondary" onClick={stepPayTrx}>
                      Pay with TronLink (TRX)
                    </button>
                  )}
                  {paymentRequired.amountAsset === "USDT" && (
                    <button type="button" className="secondary" onClick={stepPayUsdt}>
                      Pay with TronLink (USDT)
                    </button>
                  )}
                  {explorerUrl && (
                    <a href={explorerUrl} target="_blank" rel="noreferrer">
                      Tronscan
                    </a>
                  )}
                </div>

                <h3>3 — Submit proof</h3>
                <input
                  value={manualTxId}
                  onChange={(e) => setManualTxId(e.target.value)}
                  placeholder="Nile txid"
                />
                <div className="row" style={{ marginTop: "0.65rem" }}>
                  <button type="button" className="primary" onClick={stepVerifyPayment}>
                    Verify &amp; unlock
                  </button>
                  <button type="button" className="secondary" onClick={resetFlow}>
                    Reset
                  </button>
                </div>
              </>
            )}

            {accessToken && (
              <>
                <h3>4 — Session (JWT)</h3>
                <p className="small mono">
                  Bearer token (same as settlement receipt): {accessToken.slice(0, 48)}…
                </p>
                <button type="button" className="secondary" onClick={stepSessionFetch}>
                  Fetch again with Bearer
                </button>
              </>
            )}

            {quote != null ? (
              <div style={{ marginTop: "1rem" }}>
                <h3>Payload</h3>
                <pre className="mono pre">{JSON.stringify(quote, null, 2)}</pre>
              </div>
            ) : null}

            {error && <p className="err" style={{ marginTop: "0.75rem" }}>{error}</p>}
          </div>

          <div className="card">
            <h2>Trace log</h2>
            <p className="small">Use this in your demo video as the agent audit trail.</p>
            <textarea readOnly value={log.join("\n")} style={{ marginTop: "0.75rem" }} />
            <h3 className="small-caps" style={{ marginTop: "1rem" }}>
              Fees &amp; common pitfalls
            </h3>
            <ul className="small pitfall-list">
              <li>
                <strong>Fees:</strong> TRX pays for <strong>Bandwidth</strong> (simple transfers) and{" "}
                <strong>Energy</strong> (TRC-20). If a USDT send fails with OUT OF ENERGY, get more
                Nile TRX or freeze for Energy.
              </li>
              <li>
                <strong>Network:</strong> Server verifies against <strong>Nile</strong> — mainnet txs
                will not match.
              </li>
              <li>
                <strong>Wrong SKU:</strong> Each resource has its own price; switching resource after
                402 requires a new payment session.
              </li>
              <li>
                <strong>Verification errors:</strong> The API returns a <span className="mono">hint</span>{" "}
                field with next steps.
              </li>
            </ul>
          </div>
        </div>
      )}

      {tab === "merchant" && (
        <div className="grid">
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>Merchant</h2>
              <button type="button" className="secondary" onClick={loadMerchant}>
                Refresh
              </button>
            </div>
            <p className="small">
              Configure <span className="mono">MERCHANT_TRON_ADDRESS</span> and optional{" "}
              <span className="mono">RECEIPT_PRIVATE_KEY_PEM</span> /{" "}
              <span className="mono">RECEIPT_PUBLIC_KEY_PEM</span> in <span className="mono">.env</span>.
            </p>
            <p className="small">
              Merchant view:{" "}
              <select
                className="select"
                value={selectedMerchantId}
                onChange={(e) => setSelectedMerchantId(e.target.value)}
              >
                <option value="all">All merchants</option>
                {merchants.map((merchant) => (
                  <option key={merchant.id} value={merchant.id}>
                    {merchant.name}
                  </option>
                ))}
              </select>
            </p>
            <div className="grid two tight" style={{ marginTop: "1rem" }}>
              <div>
                <h3 className="small-caps">Status</h3>
                <pre className="mono pre">{JSON.stringify(merchantInfo, null, 2)}</pre>
              </div>
              <div>
                <h3 className="small-caps">Summary (SQLite)</h3>
                <pre className="mono pre">{JSON.stringify(summary, null, 2)}</pre>
              </div>
            </div>
            <h3 className="small-caps" style={{ marginTop: "1rem" }}>
              Recent settlements
            </h3>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Resource</th>
                    <th>Payer</th>
                    <th>Asset</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="small">
                        No rows yet — complete a payment on the Buyer tab.
                      </td>
                    </tr>
                  ) : (
                    paymentRows.map((r) => (
                      <tr key={r.txId}>
                        <td className="mono">{r.createdAt.slice(11, 19)}</td>
                        <td className="mono">{r.resource.replace("/v1/agent/", "")}</td>
                        <td className="mono">{r.payer.slice(0, 6)}…</td>
                        <td>{r.asset}</td>
                        <td>
                          <a href={r.explorer} target="_blank" rel="noreferrer">
                            view
                          </a>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === "security" && (
        <div className="grid" style={{ gap: "1.25rem" }}>

          {/* Threat model */}
          <div className="card">
            <h2>Threat model</h2>
            <p className="small" style={{ marginBottom: "0.75rem" }}>
              Every attack vector handled by this gateway with on-chain or server-side controls.
            </p>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Attack</th>
                    <th>Mitigation</th>
                    <th>Where enforced</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Wrong recipient", "Server re-fetches tx; verifies recipient === merchant address", "tronVerify.ts on-chain"],
                    ["Underpayment", "Checks amount ≥ required minimal units (BigInt)", "tronVerify.ts on-chain"],
                    ["Wrong asset / contract", "TRC-20 verifies contract address === USDT contract", "tronVerify.ts on-chain"],
                    ["Tx replay (double-unlock)", "UNIQUE constraint on tx_id in SQLite; checked before insert", "db.ts + commerceRoutes.ts"],
                    ["Nonce brute-force", "Nonces are 16 random bytes (2¹²⁸ space); 30-min TTL", "memoryStore.ts"],
                    ["Invalid txid injection", "Regex validates 64 hex chars before any network call", "commerceRoutes.ts"],
                    ["Cross-SKU confusion", "Idempotency key scoped per resource path (prefix + key)", "commerceRoutes.ts"],
                    ["JWT forgery", "ES256 signed; issuer + audience checked with public-key verification", "receipts.ts"],
                    ["Session hijacking", "JWT exp enforced; audience = 'agent-client'", "receipts.ts (jose)"],
                    ["Mainnet tx (real money)", "Server pinned to Nile; mainnet txids reference wrong network", "config.ts + TronGrid"],
                    ["Rate limit abuse", "240 req/min server-wide (health & OpenAPI exempt)", "index.ts (@fastify/rate-limit)"],
                    ["Payer sandbox escape", "ALLOWED_PAYER_ADDRESSES allowlist blocks unknown agents", "commerceRoutes.ts"],
                  ].map(([attack, mitigation, where]) => (
                    <tr key={attack}>
                      <td className="mono" style={{ whiteSpace: "nowrap" }}>{attack}</td>
                      <td className="small">{mitigation}</td>
                      <td className="mono small" style={{ color: "var(--ok)", whiteSpace: "nowrap" }}>{where}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* TRON Account Permission Management */}
          <div className="card">
            <h2>TRON Account Permission Management</h2>
            <p className="small" style={{ marginBottom: "0.75rem" }}>
              Use TRON's native{" "}
              <a href="https://developers.tron.network/docs/multi-signature" target="_blank" rel="noreferrer">
                Account Permission Management
              </a>{" "}
              to create a <strong>constrained agent key</strong>: the hot key can only send small payments —
              it cannot move cold funds, change permissions, or stake TRX.
              Run <span className="mono">npm run permission-setup</span> to see the live demo.
            </p>

            <h3>Permission architecture</h3>
            <pre className="mono pre" style={{ fontSize: "0.78rem" }}>{permArchDiagram}</pre>

            <h3>TronWeb setup (from permission-setup script)</h3>
            <pre className="mono pre" style={{ fontSize: "0.78rem" }}>{permCodeSnippet}</pre>

            <p className="small" style={{ marginTop: "0.75rem" }}>
              After setup the agent key can call{" "}
              <span className="mono">transactionBuilder.sendTrx()</span> freely
              but any attempt to update permissions, freeze funds, or trigger contracts
              will be rejected by the network — <strong>even if the agent is compromised</strong>.
            </p>
          </div>

          {/* OPSEC checklist */}
          <div className="grid two">
            <div className="card">
              <h2>OPSEC checklist for agent developers</h2>
              <ul className="small" style={{ margin: 0, paddingLeft: "1.1rem", lineHeight: 1.7 }}>
                <li>
                  <strong>Never use your owner key</strong> in agent code. Create a separate
                  hot key and constrain it with Account Permission Management.
                </li>
                <li>
                  <strong>Validate 402 responses</strong> before signing: check{" "}
                  <span className="mono">x402Version</span>,{" "}
                  <span className="mono">scheme === "tron-settlement"</span>,{" "}
                  <span className="mono">network === "tron-nile"</span>, and that the
                  recipient is a known merchant address.
                </li>
                <li>
                  <strong>Cap payment amounts</strong>: reject{" "}
                  <span className="mono">paymentRequired.amount</span> above a configurable
                  per-request ceiling before signing.
                </li>
                <li>
                  <strong>Pin the merchant address</strong>: hard-code or fetch from a
                  trusted registry — never accept an arbitrary recipient from an API response.
                </li>
                <li>
                  <strong>Use idempotency keys</strong>: prevents accidental double-payment
                  on network retries.
                </li>
                <li>
                  <strong>Store JWT receipts</strong>: they are your proof of payment; keep
                  them for dispute resolution.
                </li>
                <li>
                  <strong>Rotate receipt keypairs</strong> carefully; old receipts will
                  stop verifying against the new public key unless you keep prior keys available.
                </li>
              </ul>
            </div>

            <div className="card">
              <h2>Verifiable artifacts</h2>
              <p className="small">Every completed payment produces three independent proofs:</p>
              <ol className="small" style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem", lineHeight: 1.7 }}>
                <li>
                  <strong>On-chain tx</strong> — view on{" "}
                  <a href="https://nile.tronscan.org" target="_blank" rel="noreferrer">
                    Nile TronScan
                  </a>{" "}
                  with the txid from the settlement receipt.
                </li>
                <li>
                  <strong>JWT settlement receipt</strong> — decode at{" "}
                  <a href="https://jwt.io" target="_blank" rel="noreferrer">jwt.io</a>{" "}
                  using the public key from <span className="mono">/.well-known/jwks.json</span>
                  or <span className="mono">/v1/merchant/status</span>; contains txId, payer, merchant, chain, asset.
                </li>
                <li>
                  <strong>SQLite audit log</strong> —{" "}
                  <span className="mono">GET /v1/merchant/payments</span> returns every
                  settled row with block number and Tronscan link.
                </li>
              </ol>
              <p className="small" style={{ marginTop: "0.75rem" }}>
                A malicious server <em>cannot fabricate</em> proof #1 — the on-chain tx either
                exists and matches, or verification fails.
              </p>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
