/**
 * Deploy compiled contracts to TRON Nile testnet.
 * Writes deployed addresses to contracts/deployed.json.
 *
 * Env vars:
 *   DEPLOYER_PRIVATE_KEY — 64 hex chars, Nile account with TRX balance
 *   TRON_FULL_HOST       — defaults to https://nile.trongrid.io
 *   DEFAULT_LOCK_BLOCKS  — escrow lock period (default 20 ≈ 1 min on TRON)
 *
 * Usage: npx tsx contracts/deploy.ts
 */

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TronWebModule from "tronweb";

const { TronWeb } = TronWebModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const FULL_HOST = process.env.TRON_FULL_HOST ?? "https://nile.trongrid.io";
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY?.trim() ?? process.env.GATEWAY_PRIVATE_KEY?.trim() ?? "";
const DEFAULT_LOCK_BLOCKS = Number(process.env.DEFAULT_LOCK_BLOCKS ?? "20");

const BUILD_DIR = path.join(__dirname, "build");
const DEPLOYED_PATH = path.join(__dirname, "deployed.json");

function loadArtifact(name: string): { abi: unknown[]; bytecode: string } {
  const filePath = path.join(BUILD_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    console.error(`Artifact not found: ${filePath}. Run 'npx tsx contracts/compile.ts' first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

async function deploy(): Promise<void> {
  if (!DEPLOYER_KEY || DEPLOYER_KEY.length < 64) {
    console.error("Set DEPLOYER_PRIVATE_KEY or GATEWAY_PRIVATE_KEY in .env (64 hex chars).");
    process.exit(1);
  }

  const tronWeb = new TronWeb({ fullHost: FULL_HOST, privateKey: DEPLOYER_KEY });
  const deployerAddress = tronWeb.defaultAddress.base58;
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Network:  ${FULL_HOST}\n`);

  const deployed: Record<string, { address: string; txId: string; explorer: string }> = {};

  // ── Deploy EscrowPayment ─────────────────────────────────────────────────
  {
    const { abi, bytecode } = loadArtifact("EscrowPayment");
    console.log("Deploying EscrowPayment...");
    console.log(`  arbitrator:     ${deployerAddress}`);
    console.log(`  defaultLockBlocks: ${DEFAULT_LOCK_BLOCKS}`);

    const contract = await (tronWeb as any).contract().new({
      abi,
      bytecode,
      feeLimit: 1_000_000_000,
      callValue: 0,
      parameters: [deployerAddress, DEFAULT_LOCK_BLOCKS],
    });

    const address = tronWeb.address.fromHex(contract.address);
    console.log(`  ✓ EscrowPayment deployed at: ${address}`);
    console.log(`    Explorer: https://nile.tronscan.org/#/contract/${address}\n`);

    deployed.EscrowPayment = {
      address,
      txId: contract.transactionHash ?? "",
      explorer: `https://nile.tronscan.org/#/contract/${address}`,
    };
  }

  // ── Deploy AgentRegistry ────────────────────────────────────────────────
  {
    const { abi, bytecode } = loadArtifact("AgentRegistry");
    console.log("Deploying AgentRegistry...");

    const contract = await (tronWeb as any).contract().new({
      abi,
      bytecode,
      feeLimit: 1_000_000_000,
      callValue: 0,
      parameters: [],
    });

    const address = tronWeb.address.fromHex(contract.address);
    console.log(`  ✓ AgentRegistry deployed at: ${address}`);
    console.log(`    Explorer: https://nile.tronscan.org/#/contract/${address}\n`);

    deployed.AgentRegistry = {
      address,
      txId: contract.transactionHash ?? "",
      explorer: `https://nile.tronscan.org/#/contract/${address}`,
    };
  }

  // ── Write deployed.json ─────────────────────────────────────────────────
  fs.writeFileSync(DEPLOYED_PATH, JSON.stringify(deployed, null, 2));
  console.log(`Deployed addresses written to ${DEPLOYED_PATH}`);
  console.log("\nAdd these to your .env:");
  console.log(`  ESCROW_CONTRACT_ADDRESS=${deployed.EscrowPayment.address}`);
  console.log(`  AGENT_REGISTRY_CONTRACT_ADDRESS=${deployed.AgentRegistry.address}`);
}

deploy().catch((e) => {
  console.error("Deploy failed:", e);
  process.exit(1);
});
