// 把 Hardhat 编译出的 bytecode + ABI 导出成 FISCO BCOS console 期望的
// 目录结构，可以直接拷贝到部署机的 `console/contracts/abi` 和
// `console/contracts/bin` 下使用。
//
// 用法：
//   npx hardhat compile
//   node scripts/extract-artifacts.js
//
// 输出：
//   console-artifacts/abi/<name>.abi
//   console-artifacts/bin/<name>.bin
const fs = require("fs");
const path = require("path");

const targets = [
  ["contracts/WeNFTUpgradeable.sol", "WeNFTUpgradeable"],
  ["contracts/WeNFTFactory.sol", "WeNFTFactory"],
  // Beacon-proxy 基础设施合约，来自 @openzeppelin，由 WeNFTFactory 引入。
  // Hardhat 因 factory 中 import 自动编译，artifact 位于
  // artifacts/@openzeppelin/contracts/proxy/beacon/...
  [
    "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol",
    "UpgradeableBeacon",
  ],
  ["@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol", "BeaconProxy"],
];

// FISCO BCOS / EVM 默认合约大小限制（EIP-170）。
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
    console.error("       请先执行 'npx hardhat compile'");
    failed = true;
    continue;
  }
  const art = JSON.parse(fs.readFileSync(artPath, "utf8"));
  fs.writeFileSync(
    path.join(abiDir, `${name}.abi`),
    JSON.stringify(art.abi, null, 2)
  );
  // FISCO BCOS console 要求 hex 字符串不带 0x 前缀。
  const bin = (art.bytecode || "").replace(/^0x/, "");
  fs.writeFileSync(path.join(binDir, `${name}.bin`), bin);

  // 部署后实际运行字节码（受 EIP-170 大小上限约束）在 deployedBytecode 里，
  // 不是 bytecode（bytecode 还包含 constructor 段）。
  const runtimeHex = (art.deployedBytecode || "").replace(/^0x/, "");
  const runtimeKB = runtimeHex.length / 2 / 1024;
  const tag = runtimeKB > MAX_RUNTIME_KB ? "[warn]" : "[ok]  ";
  console.log(`${tag} ${name.padEnd(20)} runtime ${runtimeKB.toFixed(2)} KB`);
  if (runtimeKB > MAX_RUNTIME_KB) {
    console.warn(
      `       超出 ${MAX_RUNTIME_KB} KB 上限；可以调高 optimizer.runs 或拆分合约。`
    );
  }
}

if (failed) {
  process.exit(1);
}

console.log(`\nartifacts 已写入：${outDir}`);
console.log("\nFISCO BCOS console 目录结构（拷贝到部署机）：");
console.log("  console/contracts/abi/<name>.abi");
console.log("  console/contracts/bin/<name>.bin");
