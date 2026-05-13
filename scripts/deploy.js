const hre = require("hardhat");

// Beacon-proxy deployment, 3 steps:
//  1. Deploy the WeNFTUpgradeable implementation once.
//  2. Deploy an UpgradeableBeacon pointing at that implementation. The
//     beacon owner controls upgrades (calling beacon.upgradeTo(newImpl)
//     migrates every existing collection in a single transaction).
//  3. Deploy the WeNFTFactory pointing at the beacon. Business teams then
//     call factory.createCollection(...) to spin up independent
//     collections backed by BeaconProxy.
//
// Env overrides (both default to the deployer):
//   BEACON_OWNER   address with authority to upgrade the implementation
//   FACTORY_ADMIN  address with authority to grant CREATOR_ROLE on the factory
//
// For production, BEACON_OWNER should be a timelock or multisig contract,
// not an EOA.
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const beaconOwner = process.env.BEACON_OWNER || deployer.address;
  const factoryAdmin = process.env.FACTORY_ADMIN || deployer.address;

  const Impl = await hre.ethers.getContractFactory("WeNFTUpgradeable");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("WeNFTUpgradeable (implementation) deployed:", implAddr);

  const Beacon = await hre.ethers.getContractFactory("UpgradeableBeacon");
  const beacon = await Beacon.deploy(implAddr, beaconOwner);
  await beacon.waitForDeployment();
  const beaconAddr = await beacon.getAddress();
  console.log("UpgradeableBeacon deployed:", beaconAddr);
  console.log("  implementation:", implAddr);
  console.log("  beacon owner  :", beaconOwner);

  const Factory = await hre.ethers.getContractFactory("WeNFTFactory");
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
