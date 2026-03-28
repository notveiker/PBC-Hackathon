/**
 * Compile Solidity contracts using solc.
 * Outputs ABI + bytecode to contracts/build/.
 *
 * Usage: npx tsx contracts/compile.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, "build");

const CONTRACT_FILES = ["EscrowPayment.sol", "AgentRegistry.sol"];

function compile(): void {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const sources: Record<string, { content: string }> = {};
  for (const file of CONTRACT_FILES) {
    const filePath = path.join(__dirname, file);
    sources[file] = { content: fs.readFileSync(filePath, "utf-8") };
  }

  const input = {
    language: "Solidity",
    sources,
    settings: {
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  };

  console.log("Compiling contracts...");
  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const errors = output.errors.filter(
      (e: { severity: string }) => e.severity === "error"
    );
    if (errors.length > 0) {
      console.error("Compilation errors:");
      for (const err of errors) {
        console.error(err.formattedMessage);
      }
      process.exit(1);
    }
    // Print warnings
    for (const warn of output.errors) {
      if (warn.severity === "warning") {
        console.warn("Warning:", warn.formattedMessage?.split("\n")[0]);
      }
    }
  }

  for (const file of CONTRACT_FILES) {
    const contractName = file.replace(".sol", "");
    const compiled = output.contracts[file][contractName];

    if (!compiled) {
      console.error(`Contract ${contractName} not found in compilation output`);
      continue;
    }

    const artifact = {
      contractName,
      abi: compiled.abi,
      bytecode: compiled.evm.bytecode.object,
    };

    const outPath = path.join(BUILD_DIR, `${contractName}.json`);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
    console.log(`  ✓ ${contractName} → ${outPath}`);
    console.log(`    ABI entries: ${compiled.abi.length}, bytecode: ${artifact.bytecode.length} chars`);
  }

  console.log("\nCompilation complete.");
}

compile();
