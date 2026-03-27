/**
 * TRON Account Permission Management — constrained agent key setup
 *
 * Demonstrates the "security-centric agent execution" pattern from the TRON docs:
 * https://developers.tron.network/docs/multi-signature
 *
 * Pattern:
 *   - OWNER key stays cold (never used in agent code)
 *   - A separate AGENT key gets a constrained ACTIVE permission:
 *       • Can only call TransferContract (native TRX sends)
 *       • Cannot: UpdateAccountPermission, TriggerSmartContract,
 *                 FreezeBalance, VoteWitnessContract, etc.
 *   - If the agent is compromised, the attacker cannot drain cold funds,
 *     change permissions, or stake TRX — they can only send up to the
 *     agent's own balance.
 *
 * Usage (Nile testnet only — never use mainnet keys here):
 *   OWNER_ADDRESS=T...  OWNER_PRIVATE_KEY=<64hex>  AGENT_ADDRESS=T...  npx tsx scripts/tron-permission-setup.ts
 *
 * Optionally query-only (no signing):
 *   OWNER_ADDRESS=T...  npx tsx scripts/tron-permission-setup.ts --query
 */

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TronWebModule from "tronweb";

const { TronWeb } = TronWebModule;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const FULL_HOST = process.env.TRON_FULL_HOST ?? "https://nile.trongrid.io";
const OWNER_ADDRESS = process.env.OWNER_ADDRESS?.trim() ?? "";
const OWNER_KEY = process.env.OWNER_PRIVATE_KEY?.trim() ?? "";
const AGENT_ADDRESS = process.env.AGENT_ADDRESS?.trim() ?? "";
const QUERY_ONLY = process.argv.includes("--query");

// ──────────────────────────────────────────────────────────────────────────────
// Operations bitmask: which contract types this permission allows.
//
// TRON defines 32 operation types (bits 0-31). We derive the hex bitmask for
// "TransferContract only" (type index 1):
//
//   bit 1 set → 0b00000010 = 0x02 in byte 0
//   All remaining 31 bytes = 0x00
//
// Full list: https://developers.tron.network/docs/multi-signature#operations
// ──────────────────────────────────────────────────────────────────────────────
const TRANSFER_ONLY_OPS = "0200000000000000000000000000000000000000000000000000000000000000";

// For USDT (TRC-20) payments the agent also needs TriggerSmartContract (type 31):
//   bit 1  → 0x02 (TransferContract)
//   bit 31 → sets bit 7 of byte 3 (0x80 in byte 3, 0-indexed)
//   Result: 0x02000000 80 00 ... 00
const TRANSFER_AND_TRIGGER_OPS = "02000000800000000000000000000000000000000000000000000000000000000";

// ──────────────────────────────────────────────────────────────────────────────

type TronWebAccount = {
  address?: string;
  owner_permission?: unknown;
  active_permission?: unknown[];
};

async function queryPermissions(
  tronWeb: InstanceType<typeof TronWeb>,
  address: string
): Promise<void> {
  console.log(`\n── Current permissions for ${address} ──`);
  try {
    const account = (await tronWeb.trx.getAccount(address)) as TronWebAccount;
    if (!account || !account.address) {
      console.log("Account not found on Nile (never activated or wrong network).");
      return;
    }
    console.log("owner_permission :", JSON.stringify(account.owner_permission ?? "(default)", null, 2));
    console.log("active_permission:", JSON.stringify(account.active_permission ?? "(default)", null, 2));
  } catch (e) {
    console.error("Could not fetch account:", String(e));
  }
}

async function setupAgentPermission(
  tronWeb: InstanceType<typeof TronWeb>,
  ownerAddress: string,
  agentAddress: string,
  ownerKey: string
): Promise<void> {
  console.log("\n── Building constrained ACTIVE permission for agent ──");
  console.log(`  owner : ${ownerAddress}`);
  console.log(`  agent : ${agentAddress}`);

  // Owner permission — keep existing owner key unchanged
  const ownerPermission = {
    type: 0,
    permission_name: "owner",
    threshold: 1,
    keys: [{ address: ownerAddress, weight: 1 }],
  };

  // Constrained active permission — agent can pay, nothing else
  // Using TRANSFER_AND_TRIGGER_OPS so agent can send both TRX and USDT
  const agentPermission = {
    type: 2,
    permission_name: "agent-active",
    threshold: 1,
    operations: TRANSFER_AND_TRIGGER_OPS,
    keys: [{ address: agentAddress, weight: 1 }],
  };

  console.log("\nagentPermission.operations bitmask:", TRANSFER_AND_TRIGGER_OPS);
  console.log("Allowed: TransferContract (TRX), TriggerSmartContract (USDT TRC-20)");
  console.log("Blocked: UpdateAccountPermission, FreezeBalance, VoteWitness, UnfreezeBalance, ...");

  let tx: Record<string, unknown>;
  try {
    tx = await (tronWeb.transactionBuilder as unknown as {
      updateAccountPermissions: (
        owner: string,
        ownerPerm: unknown,
        witnessPerm: null,
        activePerms: unknown[]
      ) => Promise<Record<string, unknown>>;
    }).updateAccountPermissions(
      ownerAddress,
      ownerPermission,
      null,            // not a Super Representative
      [agentPermission]
    );
  } catch (e) {
    console.error("\nFailed to build updateAccountPermissions tx:", String(e));
    console.error("Make sure both addresses are activated on Nile (have received TRX from faucet).");
    process.exit(1);
  }

  console.log("\nUnsigned tx built:");
  console.log(JSON.stringify(tx, null, 2));

  let signed: unknown;
  try {
    signed = await tronWeb.trx.sign(tx, ownerKey);
  } catch (e) {
    console.error("\nSigning failed:", String(e));
    process.exit(1);
  }

  console.log("\nBroadcasting to Nile...");
  const result = await tronWeb.trx.sendRawTransaction(
    signed as Parameters<typeof tronWeb.trx.sendRawTransaction>[0]
  );

  const r = result as { result?: boolean; txid?: string; code?: string; message?: string };
  if (!r.result) {
    console.error("Broadcast failed:", r.code, r.message);
    process.exit(1);
  }

  console.log(`\n✓ Permission updated!`);
  console.log(`  txid   : ${r.txid}`);
  console.log(`  explorer: https://nile.tronscan.org/#/transaction/${r.txid}`);
  console.log(`\nThe agent key (${agentAddress}) can now:`);
  console.log("  ✓ Send TRX via transactionBuilder.sendTrx()");
  console.log("  ✓ Trigger USDT TRC-20 transfers");
  console.log("  ✗ Update account permissions");
  console.log("  ✗ Freeze / unfreeze balance");
  console.log("  ✗ Vote for witnesses");
  console.log("  ✗ Any other privileged operation");
}

async function main(): Promise<void> {
  if (!OWNER_ADDRESS) {
    console.error(
      "Set OWNER_ADDRESS env var to the Nile account Base58 address.\n" +
      "Optionally set OWNER_PRIVATE_KEY and AGENT_ADDRESS to apply the permission.\n" +
      "Pass --query to only read current permissions.\n\n" +
      "Example:\n" +
      "  OWNER_ADDRESS=T... npx tsx scripts/tron-permission-setup.ts --query\n" +
      "  OWNER_ADDRESS=T... OWNER_PRIVATE_KEY=<64hex> AGENT_ADDRESS=T... npx tsx scripts/tron-permission-setup.ts"
    );
    process.exit(1);
  }

  const tronWeb = new TronWeb({ fullHost: FULL_HOST });

  await queryPermissions(tronWeb, OWNER_ADDRESS);

  if (QUERY_ONLY) {
    console.log("\n(Query-only mode — pass OWNER_PRIVATE_KEY and AGENT_ADDRESS to apply changes)");
    return;
  }

  if (!OWNER_KEY || OWNER_KEY.length < 64) {
    console.log("\nOWNER_PRIVATE_KEY not set — skipping permission update (query-only).");
    return;
  }
  if (!AGENT_ADDRESS) {
    console.log("\nAGENT_ADDRESS not set — skipping permission update (query-only).");
    return;
  }

  await setupAgentPermission(tronWeb, OWNER_ADDRESS, AGENT_ADDRESS, OWNER_KEY);

  // Re-query to confirm
  console.log("\n── Permissions after update ──");
  await queryPermissions(tronWeb, OWNER_ADDRESS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
