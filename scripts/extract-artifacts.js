// Extract Hardhat-compiled bytecode + ABI into FISCO BCOS console-friendly
// layout. Output is ready to drop into `console/contracts/abi` and
// `console/contracts/bin` on the deployment box.
//
// Usage:
//   npx hardhat compile
//   node scripts/extract-artifacts.js
//
// Output:
//   console-artifacts/abi/<name>.abi
//   console-artifacts/bin/<name>.bin
const fs = require("fs");
const path = require("path");

const targets = [
  ["contracts/WeNFTUpgradeable.sol", "WeNFTUpgradeable"],
  ["contracts/WeNFTFactory.sol", "WeNFTFactory"],
];

// FISCO BCOS / EVM default contract size limit (EIP-170).
const MAX_RUNTIME_KB = 24;

const root = path.join(__dirname, "..");
const outDir = path.join(root, "console-artifacts");
const abiDir = path.join(outDir, "abi");
const binDir = path.join(outDir, "bin");
fs.mkdirSync(abiDir, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });

let failed = false;
for (const [src, name] of targets) {
  const artPath = path.join(root, "artifacts", src, `${name}.json`);
  if (!fs.existsSync(artPath)) {
    console.error(`[err]  missing artifact: ${artPath}`);
    console.error("       run 'npx hardhat compile' first");
    failed = true;
    continue;
  }
  const art = JSON.parse(fs.readFileSync(artPath, "utf8"));
  fs.writeFileSync(
    path.join(abiDir, `${name}.abi`),
    JSON.stringify(art.abi, null, 2)
  );
  // FISCO BCOS console expects raw hex without the 0x prefix.
  const bin = (art.bytecode || "").replace(/^0x/, "");
  fs.writeFileSync(path.join(binDir, `${name}.bin`), bin);

  // Deployed runtime size (the on-chain footprint that hits the EIP-170 cap)
  // is in deployedBytecode, not bytecode (which also contains constructor).
  const runtimeHex = (art.deployedBytecode || "").replace(/^0x/, "");
  const runtimeKB = runtimeHex.length / 2 / 1024;
  const tag = runtimeKB > MAX_RUNTIME_KB ? "[warn]" : "[ok]  ";
  console.log(`${tag} ${name.padEnd(20)} runtime ${runtimeKB.toFixed(2)} KB`);
  if (runtimeKB > MAX_RUNTIME_KB) {
    console.warn(
      `       exceeds ${MAX_RUNTIME_KB} KB cap; raise optimizer.runs or split the contract.`
    );
  }
}

if (failed) {
  process.exit(1);
}

console.log(`\nartifacts written to: ${outDir}`);
console.log("\nFISCO BCOS console layout (copy to deployment box):");
console.log("  console/contracts/abi/<name>.abi");
console.log("  console/contracts/bin/<name>.bin");
