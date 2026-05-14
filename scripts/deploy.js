const hre = require("hardhat");
const { ethers, upgrades } = hre;

// Beacon-proxy 部署，2 步：
//  1. upgrades.deployBeacon：部署 WeNFTUpgradeable implementation 和指向它
//     的 UpgradeableBeacon，并把 implementation 的 storage layout 记录到
//     .openzeppelin/<network>.json，供后续 upgrade 时做兼容性校验。
//  2. 手动部署 WeNFTFactory，指向上一步的 beacon。factory 本身不是 proxy，
//     所以不需要 Upgrades plugin 管理。
//
// Beacon owner 控制升级权：调 beacon.upgradeTo(newImpl) 一笔交易就能把
// 所有已部署 collection 一起切换到新 implementation。
//
// 环境变量（默认都是 deployer 自己）：
//   BEACON_OWNER   升级权所有者地址
//   FACTORY_ADMIN  factory 上 CREATOR_ROLE 的管理员地址
//
// 生产环境中 BEACON_OWNER 应该是 timelock 或多签合约地址，不应是 EOA。
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const beaconOwner = process.env.BEACON_OWNER || deployer.address;
  const factoryAdmin = process.env.FACTORY_ADMIN || deployer.address;

  const Impl = await ethers.getContractFactory("WeNFTUpgradeable");
  const beacon = await upgrades.deployBeacon(Impl, { initialOwner: beaconOwner });
  await beacon.waitForDeployment();
  const beaconAddr = await beacon.getAddress();
  const implAddr = await upgrades.beacon.getImplementationAddress(beaconAddr);
  console.log("WeNFTUpgradeable (implementation) deployed:", implAddr);
  console.log("UpgradeableBeacon deployed:", beaconAddr);
  console.log("  implementation:", implAddr);
  console.log("  beacon owner  :", beaconOwner);

  const Factory = await ethers.getContractFactory("WeNFTFactory");
  const factory = await Factory.deploy(beaconAddr, factoryAdmin);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("WeNFTFactory deployed:", factoryAddr);
  console.log("  beacon        :", beaconAddr);
  console.log("  factory admin :", factoryAdmin);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
