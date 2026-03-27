import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { assertMerchantConfigured, assertReceiptSecretForProd, config } from "./config.js";
import { openDb, pendingPaymentSummary } from "./db.js";
import { registerCommerceRoutes } from "./commerceRoutes.js";
import { createTronWeb } from "./tronVerify.js";
import { listMerchants, listServices } from "./serviceCatalog.js";

export async function buildServer() {
  assertMerchantConfigured();
  assertReceiptSecretForProd();

  const db = openDb(config.databasePath);
  const { tronWeb } = createTronWeb(config.fullHost, config.tronGridApiKey || undefined);

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(rateLimit, {
    global: true,
    max: 240,
    timeWindow: "1 minute",
    allowList: (req) => {
      const path = req.url.split("?")[0] ?? "";
      return path === "/health" || path === "/openapi.json";
    },
  });

  app.get("/health", async () => ({
    ok: true,
    service: "nile-commerce-gateway",
    expectedSettlementNetwork: "tron-nile",
    merchantConfigured: Boolean(config.merchantAddress),
    merchantCount: listMerchants().length,
    serviceCount: listServices().length,
    marketplace: true,
    pendingPayments: pendingPaymentSummary(db),
    database: config.databasePath,
    paymentAssetDefault: config.paymentAsset,
  }));

  registerCommerceRoutes(app, db, tronWeb);

  return app;
}

const thisFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (entryFile === thisFile) {
  buildServer()
    .then((app) =>
      app.listen({ port: config.port, host: "0.0.0.0" }).then(() => {
        app.log.info(`Listening on ${config.port}`);
      })
    )
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
