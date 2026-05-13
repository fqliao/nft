// End-to-end smoke run for the beacon-proxy factory:
//   deploy implementation -> deploy beacon -> deploy factory ->
//   grant CREATOR_ROLE -> create collection -> exercise mint/verify/
//   transfer/soulbound on the clone -> deterministic clone via CREATE2 ->
//   beacon upgrade (swap to a fresh impl, prove existing clones still
//   work and now read the new impl address) -> dump factory registry.
//
// Usage:
//   npx hardhat run scripts/interact.js
//   npx hardhat run scripts/interact.js --network fiscobcos
const hre = require("hardhat");
const { ethers } = hre;

function hashed(payload) {
  const raw = ethers.toUtf8Bytes(payload);
  return { raw, hash: ethers.keccak256(raw) };
}

function step(t) {
  console.log("\n=== " + t + " ===");
}

function pickCollection(receipt) {
  const ev = receipt.logs.find(
    (l) => l.fragment && l.fragment.name === "CollectionCreated"
  );
  if (!ev) throw new Error("CollectionCreated event not found in receipt");
  return ev.args.collection;
}

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, creator, alice, bob] = signers;
  console.log("deployer:", deployer.address);
  if (creator) console.log("creator :", creator.address);
  if (alice) console.log("alice   :", alice.address);
  if (bob) console.log("bob     :", bob.address);

  /* ---------- Deploy implementation ---------- */
  step("Deploy WeNFTUpgradeable implementation");
  const Impl = await ethers.getContractFactory("WeNFTUpgradeable");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("implementation @", implAddr);

  /* ---------- Deploy beacon ---------- */
  step("Deploy UpgradeableBeacon pointing at the implementation");
  const Beacon = await ethers.getContractFactory("UpgradeableBeacon");
  const beacon = await Beacon.deploy(implAddr, deployer.address);
  await beacon.waitForDeployment();
  const beaconAddr = await beacon.getAddress();
  console.log("beacon @", beaconAddr);
  console.log("beacon owner:", await beacon.owner());
  console.log("beacon.implementation():", await beacon.implementation());

  /* ---------- Deploy factory ---------- */
  step("Deploy WeNFTFactory pointing at the beacon");
  const Factory = await ethers.getContractFactory("WeNFTFactory");
  const factory = await Factory.deploy(beaconAddr, deployer.address);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("factory @", factoryAddr);

  /* ---------- Grant CREATOR_ROLE (only meaningful with multiple signers) ---------- */
  if (creator && creator.address !== deployer.address) {
    step("Grant CREATOR_ROLE to a dedicated creator EOA");
    const CREATOR_ROLE = await factory.CREATOR_ROLE();
    await (await factory.connect(deployer).grantRole(CREATOR_ROLE, creator.address)).wait();
    console.log("CREATOR_ROLE granted to", creator.address);
  }

  // On a single-signer network (fiscobcos) the deployer is also the creator
  // and every collection's admin.
  const creatorSigner = creator || deployer;
  const collectionAdmin = alice || deployer;
  const recipient = bob || deployer;

  /* ---------- Create first collection ---------- */
  step("Create collection #1: We Honor Badge");
  const tx = await factory
    .connect(creatorSigner)
    .createCollection("We Honor Badge", "WHB", collectionAdmin.address);
  const r = await tx.wait();
  const honorAddr = pickCollection(r);
  console.log("collection @", honorAddr);

  const honor = Impl.attach(honorAddr);
  console.log("name  :", await honor.name());
  console.log("symbol:", await honor.symbol());
  const DEFAULT_ADMIN_ROLE = await honor.DEFAULT_ADMIN_ROLE();
  console.log(
    "collection admin?",
    await honor.hasRole(DEFAULT_ADMIN_ROLE, collectionAdmin.address)
  );

  /* ---------- Mint + verify on the clone ---------- */
  step("Mint #1 on the Honor Badge collection (soulbound)");
  const m = hashed('{"schema":1,"name":"Q1 Star"}');
  await (
    await honor
      .connect(collectionAdmin)
      .mint(recipient.address, "ipfs://qm.../1", m.hash, "honor", "Top of Q1", true)
  ).wait();
  console.log("owner       :", await honor.ownerOf(1));
  console.log("contentHash :", (await honor.getNFTInfo(1)).contentHash);
  console.log("verifyContent(genuine) :", await honor.verifyContent(1, m.raw));
  console.log(
    "verifyContent(tampered):",
    await honor.verifyContent(1, ethers.toUtf8Bytes("evil"))
  );

  /* ---------- Soulbound enforcement on clone ---------- */
  step("Soulbound transfer (expected revert)");
  try {
    await honor.connect(recipient).transferFrom(recipient.address, collectionAdmin.address, 1);
    console.log("UNEXPECTED: transfer did NOT revert");
    process.exitCode = 1;
  } catch (e) {
    console.log("reverted as expected:", e.shortMessage || e.message.split("\n")[0]);
  }

  /* ---------- Deterministic clone via CREATE2 ---------- */
  step("Predict + create deterministic collection #2: We Mystery Box");
  const salt = ethers.id("we:mysterybox:" + Date.now());
  const predicted = await factory.predictAddress(salt);
  console.log("predicted   :", predicted);

  const tx2 = await factory
    .connect(creatorSigner)
    .createCollectionDeterministic("We Mystery Box", "WMB", collectionAdmin.address, salt);
  const r2 = await tx2.wait();
  const mboxAddr = pickCollection(r2);
  console.log("deployed at :", mboxAddr);
  console.log("match       :", mboxAddr.toLowerCase() === predicted.toLowerCase());

  /* ---------- Beacon upgrade ---------- */
  // Deploy a second implementation (same code; what matters is that it's a
  // different address) and switch the beacon to it. Existing clones must
  // keep working AND must now report the new impl as their backing logic.
  step("Beacon upgrade: deploy newImpl and call beacon.upgradeTo(newImpl)");
  const newImpl = await Impl.deploy();
  await newImpl.waitForDeployment();
  const newImplAddr = await newImpl.getAddress();
  console.log("newImpl @", newImplAddr);

  await (await beacon.connect(deployer).upgradeTo(newImplAddr)).wait();
  console.log("beacon.implementation() after upgrade:", await beacon.implementation());
  console.log("factory.implementation() (forwarded) :", await factory.implementation());

  // Prove honor still operates correctly: state survives, mints still go.
  step("Post-upgrade sanity: honor collection still works");
  console.log("honor.totalSupply (state preserved):", (await honor.totalSupply()).toString());
  const m2 = hashed("post-upgrade-" + Date.now());
  await (
    await honor
      .connect(collectionAdmin)
      .mint(recipient.address, "ipfs://qm.../post", m2.hash, "honor", "after upgrade", false)
  ).wait();
  console.log("honor.totalSupply after post-upgrade mint:", (await honor.totalSupply()).toString());

  /* ---------- Factory registry ---------- */
  step("Factory registry dump");
  const cnt = Number(await factory.collectionCount());
  console.log("collectionCount:", cnt);
  for (let i = 0; i < cnt; i++) {
    console.log(`  collectionAt(${i}):`, await factory.collectionAt(i));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
