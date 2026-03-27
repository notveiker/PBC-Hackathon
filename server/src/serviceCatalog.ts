import fs from "node:fs";
import path from "node:path";
import { config, monorepoRoot } from "./config.js";

export type ServiceHandler = "market-quote" | "market-depth" | "static-json";

export type MerchantDefinition = {
  id: string;
  name: string;
  address: string;
  trust: {
    verificationStatus: "verified" | "seeded";
    trustScore: number;
    riskTier: "low" | "medium" | "high";
    identityClaims: string[];
    controls: string[];
    profileVersion: number;
  };
};

export type ServiceDefinition = {
  id: string;
  path: string;
  handler: ServiceHandler;
  productName: string;
  merchantId: string;
  category: string;
  description: string;
  returns: string;
  pricing: {
    usdtUnits: string;
    trxSun: number;
  };
  trust: {
    riskCategory: "market-data" | "execution" | "analytics" | "content";
    safeguards: string[];
    minVerification: "verified" | "seeded";
  };
  staticResponse?: Record<string, unknown>;
};

type CatalogFile = {
  merchants?: MerchantDefinition[];
  services?: ServiceDefinition[];
};

export const IDENTIFIER_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const defaultCatalog: CatalogFile = {
  merchants: [
    {
      id: "market-alpha",
      name: "Market Alpha Research",
      address: config.merchantAddress,
      trust: {
        verificationStatus: "verified",
        trustScore: 92,
        riskTier: "low",
        identityClaims: ["merchant-address-pinned", "receipt-key-published", "nile-only"],
        controls: ["es256-receipts", "onchain-verification", "agent-policy-compatible"],
        profileVersion: 1,
      },
    },
    {
      id: "depth-vault",
      name: "Depth Vault Liquidity",
      address: config.secondaryMerchantAddress || config.merchantAddress,
      trust: {
        verificationStatus: config.secondaryMerchantAddress ? "verified" : "seeded",
        trustScore: config.secondaryMerchantAddress ? 89 : 74,
        riskTier: config.secondaryMerchantAddress ? "low" : "medium",
        identityClaims: ["merchant-address-pinned", "receipt-key-published", "nile-only"],
        controls: ["es256-receipts", "onchain-verification", "agent-policy-compatible"],
        profileVersion: 1,
      },
    },
  ],
  services: [
    {
      id: "premium-quote",
      path: "/v1/agent/premium-quote",
      handler: "market-quote",
      productName: "AI Premium Quote API",
      merchantId: "market-alpha",
      category: "market-data",
      description:
        "Real-time TRX/USDT best bid and ask prices with spread in basis points. Sourced live from Binance order book.",
      returns: "bid, ask, spread (absolute and bps), bidQty, askQty, timestamp",
      pricing: { usdtUnits: "1000000", trxSun: 1_000_000 },
      trust: {
        riskCategory: "market-data",
        safeguards: ["quoted-price-fixed", "merchant-manifest-signed", "receipt-proof"],
        minVerification: "verified",
      },
    },
    {
      id: "market-depth",
      path: "/v1/agent/market-depth",
      handler: "market-depth",
      productName: "Market Depth Feed",
      merchantId: "depth-vault",
      category: "market-data",
      description:
        "TRX/USDT order book depth: top 5 bid and ask levels with size. Useful for slippage estimation and liquidity analysis.",
      returns: "bids[5] and asks[5] each with price and size, timestamp",
      pricing: { usdtUnits: "500000", trxSun: 500_000 },
      trust: {
        riskCategory: "market-data",
        safeguards: ["quoted-price-fixed", "merchant-manifest-signed", "receipt-proof"],
        minVerification: "seeded",
      },
    },
    {
      id: "compliance-brief",
      path: "/v1/services/compliance-brief",
      handler: "static-json",
      productName: "Compliance Brief API",
      merchantId: "market-alpha",
      category: "content",
      description:
        "Signed pay-per-call compliance notes for a requested market. Demonstrates non-trading service delivery over the same TRON commerce rail.",
      returns: "brief summary, risk bullets, timestamp",
      pricing: { usdtUnits: "250000", trxSun: 250_000 },
      trust: {
        riskCategory: "content",
        safeguards: ["merchant-manifest-signed", "receipt-proof", "fixed-output-shape"],
        minVerification: "verified",
      },
      staticResponse: {
        brief: "TRON settlement can gate access to premium compliance or research outputs the same way it gates market data.",
        bullets: [
          "Per-call receipts give buyers durable proof of purchase.",
          "Merchant manifests and public keys reduce spoofed endpoints.",
          "The same transport works for content, tools, and API responses.",
        ],
      },
    },
  ],
};

export function catalogPath(): string {
  return process.env.SERVICE_CATALOG_PATH
    ? path.isAbsolute(process.env.SERVICE_CATALOG_PATH)
      ? process.env.SERVICE_CATALOG_PATH
      : path.join(monorepoRoot, process.env.SERVICE_CATALOG_PATH)
    : path.join(monorepoRoot, "config", "service-catalog.json");
}

function loadCatalog(): CatalogFile {
  const file = catalogPath();
  if (!fs.existsSync(file)) return defaultCatalog;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CatalogFile;
  return {
    merchants: parsed.merchants?.length ? parsed.merchants : defaultCatalog.merchants,
    services: parsed.services?.length ? parsed.services : defaultCatalog.services,
  };
}

function mergeById<T extends { id: string }>(base: T[], extra: T[]): T[] {
  const map = new Map(base.map((item) => [item.id, item]));
  for (const item of extra) {
    map.set(item.id, item);
  }
  return Array.from(map.values());
}

function currentCatalog(): { merchants: MerchantDefinition[]; services: ServiceDefinition[] } {
  const loaded = loadCatalog();
  return {
    merchants: mergeById(defaultCatalog.merchants ?? [], loaded.merchants ?? []),
    services: mergeById(defaultCatalog.services ?? [], loaded.services ?? []),
  };
}

function saveCatalog(catalog: CatalogFile): void {
  const file = catalogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + "\n", "utf8");
}

export function merchantManifest(merchant: MerchantDefinition): Record<string, unknown> {
  return {
    merchantId: merchant.id,
    name: merchant.name,
    address: merchant.address,
    trust: merchant.trust,
    network: "tron-nile",
    settlementScheme: "tron-settlement",
  };
}

export function servicePathForId(serviceId: string): string {
  return `/v1/services/${serviceId}`;
}

export function isValidCatalogIdentifier(value: string): boolean {
  return IDENTIFIER_RE.test(value);
}

export function serviceManifest(service: ServiceDefinition): Record<string, unknown> {
  return {
    serviceId: service.id,
    path: service.path,
    handler: service.handler,
    merchantId: service.merchantId,
    productName: service.productName,
    category: service.category,
    description: service.description,
    returns: service.returns,
    pricing: service.pricing,
    trust: service.trust,
  };
}

export function listMerchants(): MerchantDefinition[] {
  return currentCatalog().merchants;
}

export function listServices(): ServiceDefinition[] {
  return currentCatalog().services;
}

export function getMerchantById(id: string): MerchantDefinition {
  const merchant = listMerchants().find((item) => item.id === id);
  if (!merchant) {
    throw new Error(`Unknown merchant id: ${id}`);
  }
  return merchant;
}

export function getServiceByPath(pathname: string): ServiceDefinition | undefined {
  return listServices().find((service) => service.path === pathname);
}

export function getServiceById(id: string): ServiceDefinition | undefined {
  return listServices().find((service) => service.id === id);
}

export function merchantExists(id: string): boolean {
  return listMerchants().some((merchant) => merchant.id === id);
}

export function serviceExists(id: string): boolean {
  return listServices().some((service) => service.id === id);
}

export function servicePathExists(pathname: string): boolean {
  return listServices().some((service) => service.path === pathname);
}

export function createMerchant(merchant: MerchantDefinition): MerchantDefinition {
  if (merchantExists(merchant.id)) {
    throw new Error(`Merchant already exists: ${merchant.id}`);
  }
  const loaded = loadCatalog();
  const merchants = [...(loaded.merchants ?? []), merchant];
  saveCatalog({
    merchants,
    services: loaded.services ?? [],
  });
  return merchant;
}

export function createService(service: ServiceDefinition): ServiceDefinition {
  if (serviceExists(service.id)) {
    throw new Error(`Service already exists: ${service.id}`);
  }
  if (servicePathExists(service.path)) {
    throw new Error(`Service path already exists: ${service.path}`);
  }
  const loaded = loadCatalog();
  const services = [...(loaded.services ?? []), service];
  saveCatalog({
    merchants: loaded.merchants ?? [],
    services,
  });
  return service;
}
