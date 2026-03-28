/**
 * Verify deployed contracts on TRON Nile testnet.
 * Reads contracts/deployed.json and calls each contract to confirm it responds.
 *
 * Usage: npx tsx contracts/verify.ts
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
const DEPLOYED_PATH = path.join(__dirname, "deployed.json");
const BUILD_DIR = path.join(__dirname, "build");

function loadArtifact(name: string): { abi: unknown[] } {
  return JSON.parse(fs.readFileSync(path.join(BUILD_DIR, `${name}.json`), "utf-8"));
}

async function verify(): Promise<void> {
  if (!fs.existsSync(DEPLOYED_PATH)) {
    console.error("No deployed.json found. Run deploy first.");
    process.exit(1);
  }

  const deployed = JSON.parse(fs.readFileSync(DEPLOYED_PATH, "utf-8"));
  const tronWeb = new TronWeb({ fullHost: FULL_HOST });

  console.log("Verifying deployed contracts...\n");

  // ── Verify EscrowPayment ────────────────────────────────────────────────
  if (deployed.EscrowPayment) {
    const { abi } = loadArtifact("EscrowPayment");
    const address = deployed.EscrowPayment.address;
    console.log(`EscrowPayment at ${address}`);

    try {
      const contract = await tronWeb.contract(abi, address);
      const arbitrator = await contract.arbitrator().call();
      const lockBlocks = await contract.defaultLockBlocks().call();
      const nextId = await contract.nextEscrowId().call();

      console.log(`  ✓ arbitrator:       ${tronWeb.address.fromHex(arbitrator)}`);
      console.log(`  ✓ defaultLockBlocks: ${lockBlocks}`);
      console.log(`  ✓ nextEscrowId:     ${nextId}`);
      console.log(`  ✓ Explorer: ${deployed.EscrowPayment.explorer}`);
    } catch (e) {
      console.error(`  ✗ Verification failed: ${String(e)}`);
    }
  }

  console.log();

  // ── Verify AgentRegistry ────────────────────────────────────────────────
  if (deployed.AgentRegistry) {
    const { abi } = loadArtifact("AgentRegistry");
    const address = deployed.AgentRegistry.address;
    console.log(`AgentRegistry at ${address}`);

    try {
      const contract = await tronWeb.contract(abi, address);
      const owner = await contract.owner().call();
      const total = await contract.totalAgents().call();

      console.log(`  ✓ owner:       ${tronWeb.address.fromHex(owner)}`);
      console.log(`  ✓ totalAgents: ${total}`);
      console.log(`  ✓ Explorer: ${deployed.AgentRegistry.explorer}`);
    } catch (e) {
      console.error(`  ✗ Verification failed: ${String(e)}`);
    }
  }

  console.log("\nVerification complete.");
}

verify().catch((e) => {
  console.error(e);
  process.exit(1);
});
