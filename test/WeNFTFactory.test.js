const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

function makeContent(payload) {
  const raw = ethers.toUtf8Bytes(payload);
  const hash = ethers.keccak256(raw);
  return { raw, hash };
}

// Extract the cloned collection address from a CollectionCreated event log.
function pickCollection(receipt) {
  const ev = receipt.logs.find(
    (l) => l.fragment && l.fragment.name === "CollectionCreated"
  );
  return ev.args.collection;
}

describe("WeNFTFactory", function () {
  async function deployFactoryFixture() {
    const [deployer, creator, alice, bob, carol, attacker] = await ethers.getSigners();

    const WeNFTUpgradeable = await ethers.getContractFactory("WeNFTUpgradeable");
    const impl = await WeNFTUpgradeable.deploy();
    await impl.waitForDeployment();

    const WeNFTFactory = await ethers.getContractFactory("WeNFTFactory");
    const factory = await WeNFTFactory.deploy(
      await impl.getAddress(),
      deployer.address
    );
    await factory.waitForDeployment();

    const CREATOR_ROLE = await factory.CREATOR_ROLE();
    const DEFAULT_ADMIN_ROLE = await factory.DEFAULT_ADMIN_ROLE();
    await factory.connect(deployer).grantRole(CREATOR_ROLE, creator.address);

    return {
      factory,
      impl,
      deployer,
      creator,
      alice,
      bob,
      carol,
      attacker,
      CREATOR_ROLE,
      DEFAULT_ADMIN_ROLE,
    };
  }

  /* ------------------ Deployment ------------------ */
  describe("Deployment", () => {
    it("records implementation address", async () => {
      const { factory, impl } = await loadFixture(deployFactoryFixture);
      expect(await factory.implementation()).to.equal(await impl.getAddress());
    });

    it("grants admin & creator roles to constructor admin", async () => {
      const { factory, deployer, CREATOR_ROLE, DEFAULT_ADMIN_ROLE } =
        await loadFixture(deployFactoryFixture);
      expect(await factory.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)).to.equal(true);
      expect(await factory.hasRole(CREATOR_ROLE, deployer.address)).to.equal(true);
    });

    it("rejects zero implementation", async () => {
      const [deployer] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("WeNFTFactory");
      await expect(
        Factory.deploy(ethers.ZeroAddress, deployer.address)
      ).to.be.revertedWithCustomError(Factory, "ZeroImplementation");
    });

    it("rejects zero admin", async () => {
      const [deployer] = await ethers.getSigners();
      const Impl = await ethers.getContractFactory("WeNFTUpgradeable");
      const impl = await Impl.deploy();
      const Factory = await ethers.getContractFactory("WeNFTFactory");
      await expect(
        Factory.deploy(await impl.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(Factory, "ZeroAdmin");
    });
  });

  /* ------------------ Implementation lockdown ------------------ */
  describe("Implementation lockdown", () => {
    it("implementation itself cannot be initialized", async () => {
      const { impl, alice } = await loadFixture(deployFactoryFixture);
      await expect(
        impl.initialize("X", "X", alice.address)
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  /* ------------------ Create collection ------------------ */
  describe("createCollection", () => {
    it("clones and initializes a new collection", async () => {
      const { factory, creator, alice } = await loadFixture(deployFactoryFixture);

      const tx = await factory
        .connect(creator)
        .createCollection("Honor Badge", "HNR", alice.address);
      const receipt = await tx.wait();
      const collAddr = pickCollection(receipt);

      const Coll = await ethers.getContractFactory("WeNFTUpgradeable");
      const coll = Coll.attach(collAddr);

      expect(await coll.name()).to.equal("Honor Badge");
      expect(await coll.symbol()).to.equal("HNR");
      const DEFAULT_ADMIN_ROLE = await coll.DEFAULT_ADMIN_ROLE();
      expect(await coll.hasRole(DEFAULT_ADMIN_ROLE, alice.address)).to.equal(true);

      expect(await factory.collectionCount()).to.equal(1n);
      expect(await factory.collectionAt(0)).to.equal(collAddr);
    });

    it("emits CollectionCreated with creator/collection/admin", async () => {
      const { factory, creator, alice } = await loadFixture(deployFactoryFixture);
      const tx = await factory
        .connect(creator)
        .createCollection("X", "X", alice.address);
      const receipt = await tx.wait();
      const collAddr = pickCollection(receipt);

      await expect(tx)
        .to.emit(factory, "CollectionCreated")
        .withArgs(creator.address, collAddr, alice.address, "X", "X", ethers.ZeroHash);
    });

    it("rejects creation from a non-creator", async () => {
      const { factory, attacker, alice, CREATOR_ROLE } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.connect(attacker).createCollection("X", "X", alice.address)
      )
        .to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, CREATOR_ROLE);
    });

    it("clones have independent state", async () => {
      const { factory, creator, alice, bob } = await loadFixture(deployFactoryFixture);

      const r1 = await (
        await factory.connect(creator).createCollection("A", "A", alice.address)
      ).wait();
      const addr1 = pickCollection(r1);

      const r2 = await (
        await factory.connect(creator).createCollection("B", "B", bob.address)
      ).wait();
      const addr2 = pickCollection(r2);

      expect(addr1).to.not.equal(addr2);

      const Coll = await ethers.getContractFactory("WeNFTUpgradeable");
      const c1 = Coll.attach(addr1);
      const c2 = Coll.attach(addr2);

      expect(await c1.name()).to.equal("A");
      expect(await c2.name()).to.equal("B");

      // Mint in c1, c2 must be unaffected.
      const { hash } = makeContent("payload");
      await c1.connect(alice).mint(alice.address, "u", hash, "honor", "good work", false);
      expect(await c1.totalSupply()).to.equal(1n);
      expect(await c2.totalSupply()).to.equal(0n);
    });
  });

  /* ------------------ Deterministic deployment ------------------ */
  describe("createCollectionDeterministic", () => {
    it("address matches predictAddress for same salt", async () => {
      const { factory, creator, alice } = await loadFixture(deployFactoryFixture);
      const salt = ethers.id("we:honor:2026q1");

      const predicted = await factory.predictAddress(salt);

      const tx = await factory
        .connect(creator)
        .createCollectionDeterministic("X", "X", alice.address, salt);
      const receipt = await tx.wait();
      const collAddr = pickCollection(receipt);

      expect(collAddr).to.equal(predicted);
    });

    it("reverts when salt is reused", async () => {
      const { factory, creator, alice } = await loadFixture(deployFactoryFixture);
      const salt = ethers.id("dup");
      await factory
        .connect(creator)
        .createCollectionDeterministic("A", "A", alice.address, salt);

      await expect(
        factory
          .connect(creator)
          .createCollectionDeterministic("B", "B", alice.address, salt)
      ).to.be.reverted;
    });
  });

  /* ------------------ Cloned collection end-to-end ------------------ */
  describe("Cloned collection functionality", () => {
    it("supports full mint/transfer/verify/burn flow", async () => {
      const { factory, creator, alice, bob } = await loadFixture(deployFactoryFixture);

      const r = await (
        await factory.connect(creator).createCollection("T", "T", alice.address)
      ).wait();
      const collAddr = pickCollection(r);

      const Coll = await ethers.getContractFactory("WeNFTUpgradeable");
      const coll = Coll.attach(collAddr);

      const { raw, hash } = makeContent('{"name":"Q1 Star"}');

      // mint
      await coll.connect(alice).mint(alice.address, "ipfs://x", hash, "honor", "good", false);
      expect(await coll.ownerOf(1)).to.equal(alice.address);

      // verify
      expect(await coll.verifyContent(1, raw)).to.equal(true);

      // transfer (non-soulbound)
      await coll.connect(alice).transferFrom(alice.address, bob.address, 1);
      expect(await coll.ownerOf(1)).to.equal(bob.address);

      // soulbound on a second token in same collection
      const { hash: h2 } = makeContent("s");
      await coll.connect(alice).mint(bob.address, "u2", h2, "honor", "soul", true);
      await expect(
        coll.connect(bob).transferFrom(bob.address, alice.address, 2)
      ).to.be.revertedWithCustomError(coll, "SoulboundToken").withArgs(2);

      // burn (clears existence even when soulbound)
      await coll.connect(bob).burn(2);
      expect(await coll.exists(2)).to.equal(false);
    });
  });
});
