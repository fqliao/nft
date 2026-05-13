// WeNFTFactory integration tests for a live FISCO BCOS node.
//
// Constraints (tailored to a real network with one signer):
//   - Single signer (the deployer) is also the factory admin, creator, and
//     the admin of every cloned collection.
//   - One shared factory deployment for the whole file (`before`). FISCO
//     BCOS does not support evm_snapshot / evm_revert, so loadFixture
//     cannot be used.
//   - No impersonation, no unauthorized-caller negatives — there is no
//     second account to play the attacker on this network.
//
// Run:
//   npx hardhat test test/fiscobcos/WeNFTFactory.fiscobcos.test.js --network fiscobcos

const { expect } = require("chai");
const { ethers } = require("hardhat");

function makeContent(payload) {
  const raw = ethers.toUtf8Bytes(payload);
  const hash = ethers.keccak256(raw);
  return { raw, hash };
}

function pickCollection(receipt) {
  const ev = receipt.logs.find(
    (l) => l.fragment && l.fragment.name === "CollectionCreated"
  );
  if (!ev) throw new Error("CollectionCreated event not found in receipt");
  return ev.args.collection;
}

describe("WeNFTFactory @ fiscobcos", function () {
  let admin;
  let impl;
  let implAddr;
  let factory;
  let Coll; // ContractFactory for WeNFTUpgradeable, reused to attach to clones
  let CREATOR_ROLE;
  let DEFAULT_ADMIN_ROLE;

  before(async function () {
    const signers = await ethers.getSigners();
    admin = signers[0];

    const Impl = await ethers.getContractFactory("WeNFTUpgradeable");
    impl = await Impl.deploy();
    await impl.waitForDeployment();
    implAddr = await impl.getAddress();

    const Factory = await ethers.getContractFactory("WeNFTFactory");
    factory = await Factory.deploy(implAddr, admin.address);
    await factory.waitForDeployment();

    Coll = Impl;
    CREATOR_ROLE = await factory.CREATOR_ROLE();
    DEFAULT_ADMIN_ROLE = await factory.DEFAULT_ADMIN_ROLE();
  });

  /* ------------------ Deployment ------------------ */
  describe("Deployment", () => {
    it("records implementation address", async () => {
      expect(await factory.implementation()).to.equal(implAddr);
    });

    it("grants admin & creator roles to the deployer", async () => {
      expect(await factory.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await factory.hasRole(CREATOR_ROLE, admin.address)).to.equal(true);
    });

    it("rejects zero implementation", async () => {
      const Factory = await ethers.getContractFactory("WeNFTFactory");
      await expect(
        Factory.deploy(ethers.ZeroAddress, admin.address)
      ).to.be.revertedWithCustomError(Factory, "ZeroImplementation");
    });

    it("rejects zero admin", async () => {
      const Factory = await ethers.getContractFactory("WeNFTFactory");
      await expect(
        Factory.deploy(implAddr, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(Factory, "ZeroAdmin");
    });
  });

  /* ------------------ Implementation lockdown ------------------ */
  describe("Implementation lockdown", () => {
    it("implementation itself cannot be initialized", async () => {
      await expect(
        impl.initialize("X", "X", admin.address)
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  /* ------------------ Create collection ------------------ */
  describe("createCollection", () => {
    it("clones and initializes a new collection", async () => {
      const countBefore = await factory.collectionCount();

      const tx = await factory
        .connect(admin)
        .createCollection("Honor Badge", "HNR", admin.address);
      const receipt = await tx.wait();
      const collAddr = pickCollection(receipt);

      const coll = Coll.attach(collAddr);

      expect(await coll.name()).to.equal("Honor Badge");
      expect(await coll.symbol()).to.equal("HNR");
      const COLL_ADMIN_ROLE = await coll.DEFAULT_ADMIN_ROLE();
      expect(await coll.hasRole(COLL_ADMIN_ROLE, admin.address)).to.equal(true);

      expect(await factory.collectionCount()).to.equal(countBefore + 1n);
      expect(await factory.collectionAt(countBefore)).to.equal(collAddr);
    });

    it("emits CollectionCreated with creator/collection/admin", async () => {
      const tx = await factory
        .connect(admin)
        .createCollection("X", "X", admin.address);
      const receipt = await tx.wait();
      const collAddr = pickCollection(receipt);

      await expect(tx)
        .to.emit(factory, "CollectionCreated")
        .withArgs(admin.address, collAddr, admin.address, "X", "X", ethers.ZeroHash);
    });

    it("clones have independent state", async () => {
      const r1 = await (
        await factory.connect(admin).createCollection("A", "A", admin.address)
      ).wait();
      const addr1 = pickCollection(r1);

      const r2 = await (
        await factory.connect(admin).createCollection("B", "B", admin.address)
      ).wait();
      const addr2 = pickCollection(r2);

      expect(addr1).to.not.equal(addr2);

      const c1 = Coll.attach(addr1);
      const c2 = Coll.attach(addr2);

      expect(await c1.name()).to.equal("A");
      expect(await c2.name()).to.equal("B");

      const { hash } = makeContent("indep-" + Date.now());
      await (
        await c1
          .connect(admin)
          .mint(admin.address, "u", hash, "honor", "good work", false)
      ).wait();
      expect(await c1.totalSupply()).to.equal(1n);
      expect(await c2.totalSupply()).to.equal(0n);
    });
  });

  /* ------------------ Deterministic deployment ------------------ */
  describe("createCollectionDeterministic", () => {
    it("address matches predictAddress for same salt", async () => {
      // Salt randomized so reruns against the same factory address do not
      // collide with a previously consumed salt.
      const salt = ethers.id("we:honor:fbcos:" + Date.now() + ":" + Math.random());
      const predicted = await factory.predictAddress(salt);

      const tx = await factory
        .connect(admin)
        .createCollectionDeterministic("X", "X", admin.address, salt);
      const receipt = await tx.wait();
      const collAddr = pickCollection(receipt);

      expect(collAddr).to.equal(predicted);
    });

    it("reverts when salt is reused", async () => {
      const salt = ethers.id("dup:" + Date.now() + ":" + Math.random());
      await (
        await factory
          .connect(admin)
          .createCollectionDeterministic("A", "A", admin.address, salt)
      ).wait();

      await expect(
        factory
          .connect(admin)
          .createCollectionDeterministic("B", "B", admin.address, salt)
      ).to.be.reverted;
    });
  });

  /* ------------------ Cloned collection end-to-end ------------------ */
  describe("Cloned collection functionality", () => {
    it("supports mint / verify / self-transfer / soulbound / burn", async () => {
      const r = await (
        await factory
          .connect(admin)
          .createCollection("T", "T", admin.address)
      ).wait();
      const collAddr = pickCollection(r);
      const coll = Coll.attach(collAddr);

      // Mint #1 non-soulbound.
      const { raw, hash } = makeContent('{"name":"Q1 Star"}-' + Date.now());
      await (
        await coll
          .connect(admin)
          .mint(admin.address, "ipfs://x", hash, "honor", "good", false)
      ).wait();
      expect(await coll.ownerOf(1)).to.equal(admin.address);

      // Verify content integrity.
      expect(await coll.verifyContent(1, raw)).to.equal(true);

      // Self-transfer is permitted on non-soulbound tokens.
      await (
        await coll
          .connect(admin)
          .transferFrom(admin.address, admin.address, 1)
      ).wait();
      expect(await coll.ownerOf(1)).to.equal(admin.address);

      // Mint #2 soulbound; self-transfer must revert.
      const { hash: h2 } = makeContent("s-" + Date.now());
      await (
        await coll
          .connect(admin)
          .mint(admin.address, "u2", h2, "honor", "soul", true)
      ).wait();
      await expect(
        coll.connect(admin).transferFrom(admin.address, admin.address, 2)
      )
        .to.be.revertedWithCustomError(coll, "SoulboundToken")
        .withArgs(2);

      // Burn the soulbound token; existence cleared.
      await (await coll.connect(admin).burn(2)).wait();
      expect(await coll.exists(2)).to.equal(false);
    });
  });
});
