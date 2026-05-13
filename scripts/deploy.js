const hre = require("hardhat");

// Factory-pattern deployment:
//  1. Deploy the WeNFTUpgradeable implementation once.
//  2. Deploy the WeNFTFactory pointing at that implementation.
// Business teams then call factory.createCollection(...) to spin up
// independent collections via ERC-1167 minimal proxies.
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const factoryAdmin = process.env.FACTORY_ADMIN || deployer.address;

  const Impl = await hre.ethers.getContractFactory("WeNFTUpgradeable");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("WeNFTUpgradeable (implementation) deployed:", implAddr);

  const Factory = await hre.ethers.getContractFactory("WeNFTFactory");
  const factory = await Factory.deploy(implAddr, factoryAdmin);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("WeNFTFactory deployed:", factoryAddr);
  console.log("  implementation:", implAddr);
  console.log("  factory admin :", factoryAdmin);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
