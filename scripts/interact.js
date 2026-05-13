// End-to-end smoke run for the factory pattern:
//   deploy implementation -> deploy factory -> grant CREATOR_ROLE ->
//   create collection -> exercise mint/verify/transfer/soulbound on the
//   clone -> deterministic clone via CREATE2 -> dump factory registry.
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
  const [deployer, creator, alice, bob] = await ethers.getSigners();
  console.log("deployer:", deployer.address);
  console.log("creator :", creator.address);
  console.log("alice   :", alice.address);
  console.log("bob     :", bob.address);

  /* ---------- Deploy implementation ---------- */
  step("Deploy WeNFTUpgradeable implementation");
  const Impl = await ethers.getContractFactory("WeNFTUpgradeable");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("implementation @", implAddr);

  /* ---------- Deploy factory ---------- */
  step("Deploy WeNFTFactory pointing at the implementation");
  const Factory = await ethers.getContractFactory("WeNFTFactory");
  const factory = await Factory.deploy(implAddr, deployer.address);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("factory @", factoryAddr);

  /* ---------- Grant CREATOR_ROLE ---------- */
  step("Grant CREATOR_ROLE to the business creator EOA");
  const CREATOR_ROLE = await factory.CREATOR_ROLE();
  await (await factory.connect(deployer).grantRole(CREATOR_ROLE, creator.address)).wait();
  console.log("CREATOR_ROLE granted to", creator.address);

  /* ---------- Create first collection ---------- */
  step("Create collection #1: We Honor Badge");
  const tx = await factory.connect(creator).createCollection(
    "We Honor Badge",
    "WHB",
    alice.address // alice is the collection admin
  );
  const r = await tx.wait();
  const honorAddr = pickCollection(r);
  console.log("collection @", honorAddr);

  const honor = Impl.attach(honorAddr);
  console.log("name  :", await honor.name());
  console.log("symbol:", await honor.symbol());
  const DEFAULT_ADMIN_ROLE = await honor.DEFAULT_ADMIN_ROLE();
  console.log(
    "alice is admin?",
    await honor.hasRole(DEFAULT_ADMIN_ROLE, alice.address)
  );

  /* ---------- Mint + verify on the clone ---------- */
  step("Mint #1 on the Honor Badge collection (soulbound)");
  const m = hashed('{"schema":1,"name":"Q1 Star"}');
  await (
    await honor
      .connect(alice)
      .mint(bob.address, "ipfs://qm.../1", m.hash, "honor", "Top of Q1", true)
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
    await honor.connect(bob).transferFrom(bob.address, alice.address, 1);
    console.log("UNEXPECTED: transfer did NOT revert");
    process.exitCode = 1;
  } catch (e) {
    console.log("reverted as expected:", e.shortMessage || e.message.split("\n")[0]);
  }

  /* ---------- Deterministic clone via CREATE2 ---------- */
  step("Predict + create deterministic collection #2: We Mystery Box");
  const salt = ethers.id("we:mysterybox:2026q2");
  const predicted = await factory.predictAddress(salt);
  console.log("predicted   :", predicted);

  const tx2 = await factory
    .connect(creator)
    .createCollectionDeterministic("We Mystery Box", "WMB", alice.address, salt);
  const r2 = await tx2.wait();
  const mboxAddr = pickCollection(r2);
  console.log("deployed at :", mboxAddr);
  console.log("match       :", mboxAddr.toLowerCase() === predicted.toLowerCase());

  /* ---------- Transfer works on non-soulbound clone ---------- */
  step("Mint #1 on Mystery Box and transfer (non-soulbound)");
  const mbox = Impl.attach(mboxAddr);
  const m2 = hashed('{"name":"Common Box","rarity":"R"}');
  await (
    await mbox
      .connect(alice)
      .mint(alice.address, "ipfs://qm.../mbox/1", m2.hash, "mystery-box", "drop", false)
  ).wait();
  await (await mbox.connect(alice).transferFrom(alice.address, bob.address, 1)).wait();
  console.log("mbox #1 owner after transfer:", await mbox.ownerOf(1));

  /* ---------- Independence between collections ---------- */
  step("Collections are independent");
  console.log("honor.totalSupply :", (await honor.totalSupply()).toString());
  console.log("mbox.totalSupply  :", (await mbox.totalSupply()).toString());

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
