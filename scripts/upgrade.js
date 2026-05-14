const hre = require("hardhat");
const { ethers, upgrades } = hre;

// Beacon 升级入口脚本。取代"手撸部署 newImpl + 手动调 beacon.upgradeTo"
// 的做法，调用 plugin 的 upgradeBeacon 一步完成，同时对新 impl 跑一次
// OpenZeppelin storage-layout 兼容性校验（基线在 .openzeppelin/<network>.json，
// 是首次部署时写入的）。
//
// 必填环境变量：
//   BEACON_ADDR    要升级的 UpgradeableBeacon 合约地址
//
// 选填环境变量：
//   IMPL_NAME      要编译并部署的新 implementation 合约名。默认 "WeNFTUpgradeable"。
//
// 运行此脚本的 signer 必须是 beacon owner（部署时由 BEACON_OWNER 指定）。
// 生产环境中 owner 通常是 timelock / 多签，此时本脚本无法直接调 upgradeTo，
// 应改用 upgrades.prepareUpgrade（只部署 newImpl 并返回地址，不调 upgradeTo），
// 然后让 timelock / 多签按治理流程提议 + 执行 upgradeTo。
async function main() {
  const beaconAddr = process.env.BEACON_ADDR;
  if (!beaconAddr) {
    throw new Error("BEACON_ADDR env var is required");
  }
  const implName = process.env.IMPL_NAME || "WeNFTUpgradeable";

  const [signer] = await ethers.getSigners();
  console.log("Signer        :", signer.address);
  console.log("Beacon        :", beaconAddr);
  console.log("New impl name :", implName);

  const oldImplAddr = await upgrades.beacon.getImplementationAddress(beaconAddr);
  console.log("Current impl  :", oldImplAddr);

  const NewImpl = await ethers.getContractFactory(implName);

  // 先校验，确认 layout 兼容、没踩 unsafe pattern，再广播交易。
  // 校验失败会直接抛错，避免发出一笔会破坏 collection 的升级 tx。
  console.log("Validating new implementation against stored layout...");
  await upgrades.validateUpgrade(beaconAddr, NewImpl, { kind: "beacon" });
  console.log("  layout check  : OK");

  // 一步完成：部署 newImpl + 调 beacon.upgradeTo。
  // 返回的是 beacon 合约对象。
  const beacon = await upgrades.upgradeBeacon(beaconAddr, NewImpl);
  await beacon.waitForDeployment();

  const newImplAddr = await upgrades.beacon.getImplementationAddress(beaconAddr);
  console.log("Upgraded.");
  console.log("  new impl      :", newImplAddr);
  if (newImplAddr.toLowerCase() === oldImplAddr.toLowerCase()) {
    console.warn(
      "  note: 新 impl 地址等于旧 impl 地址。plugin 在 bytecode 完全一致时" +
        "会复用现有部署（redeployImplementation 默认 'onchange'）。" +
        "链上其实没有任何变化。"
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
