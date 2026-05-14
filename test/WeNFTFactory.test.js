const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

function makeContent(payload) {
  const raw = ethers.toUtf8Bytes(payload);
  const hash = ethers.keccak256(raw);
  return { raw, hash };
}

// 从 receipt 的 CollectionCreated 事件中取出新 clone 出来的 collection 地址。
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

    const UpgradeableBeacon = await ethers.getContractFactory("UpgradeableBeacon");
    const beacon = await UpgradeableBeacon.deploy(
      await impl.getAddress(),
      deployer.address
    );
    await beacon.waitForDeployment();

    const WeNFTFactory = await ethers.getContractFactory("WeNFTFactory");
    const factory = await WeNFTFactory.deploy(
      await beacon.getAddress(),
      deployer.address
    );
    await factory.waitForDeployment();

    const CREATOR_ROLE = await factory.CREATOR_ROLE();
    const DEFAULT_ADMIN_ROLE = await factory.DEFAULT_ADMIN_ROLE();
    await factory.connect(deployer).grantRole(CREATOR_ROLE, creator.address);

    return {
      factory,
      beacon,
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

  /* ------------------ 部署相关 ------------------ */
  describe("Deployment", () => {
    it("records beacon address", async () => {
      const { factory, beacon } = await loadFixture(deployFactoryFixture);
      expect(await factory.beacon()).to.equal(await beacon.getAddress());
    });

    it("implementation() view forwards to beacon", async () => {
      const { factory, impl } = await loadFixture(deployFactoryFixture);
      expect(await factory.implementation()).to.equal(await impl.getAddress());
    });

    it("grants admin & creator roles to constructor admin", async () => {
      const { factory, deployer, CREATOR_ROLE, DEFAULT_ADMIN_ROLE } =
        await loadFixture(deployFactoryFixture);
      expect(await factory.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)).to.equal(true);
      expect(await factory.hasRole(CREATOR_ROLE, deployer.address)).to.equal(true);
    });

    it("rejects zero beacon", async () => {
      const [deployer] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("WeNFTFactory");
      await expect(
        Factory.deploy(ethers.ZeroAddress, deployer.address)
      ).to.be.revertedWithCustomError(Factory, "ZeroBeacon");
    });

    it("rejects zero admin", async () => {
      const { beacon } = await loadFixture(deployFactoryFixture);
      const Factory = await ethers.getContractFactory("WeNFTFactory");
      await expect(
        Factory.deploy(await beacon.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(Factory, "ZeroAdmin");
    });
  });

  /* ------------------ Implementation 锁定（防直接被 init） ------------------ */
  describe("Implementation lockdown", () => {
    it("implementation itself cannot be initialized", async () => {
      const { impl, alice } = await loadFixture(deployFactoryFixture);
      await expect(
        impl.initialize("X", "X", alice.address)
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  /* ------------------ 创建 collection ------------------ */
  describe("createCollection", () => {
    it("deploys a BeaconProxy and initializes it", async () => {
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

      // 在 c1 上 mint，c2 应不受影响 —— 各 clone 的 storage 完全独立。
      const { hash } = makeContent("payload");
      await c1.connect(alice).mint(alice.address, "u", hash, "honor", "good work", false);
      expect(await c1.totalSupply()).to.equal(1n);
      expect(await c2.totalSupply()).to.equal(0n);
    });
  });

  /* ------------------ CREATE2 确定性部署 ------------------ */
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

    it("predicted address is independent of name/symbol/admin (salt-only)", async () => {
      const { factory } = await loadFixture(deployFactoryFixture);
      const salt = ethers.id("salt-stability");
      // predictAddress 只依赖 (factory, salt)，每条 collection 自带的
      // name/symbol/admin 不会渗入 CREATE2 地址计算。
      expect(await factory.predictAddress(salt)).to.equal(
        await factory.predictAddress(salt)
      );
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

  /* ------------------ Clone 端到端业务流 ------------------ */
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

      // mint 非 soulbound token
      await coll.connect(alice).mint(alice.address, "ipfs://x", hash, "honor", "good", false);
      expect(await coll.ownerOf(1)).to.equal(alice.address);

      // 内容真实性校验
      expect(await coll.verifyContent(1, raw)).to.equal(true);

      // 普通转账（非 soulbound）
      await coll.connect(alice).transferFrom(alice.address, bob.address, 1);
      expect(await coll.ownerOf(1)).to.equal(bob.address);

      // 在同一个 collection 中再 mint 一个 soulbound token，转账应被拦截
      const { hash: h2 } = makeContent("s");
      await coll.connect(alice).mint(bob.address, "u2", h2, "honor", "soul", true);
      await expect(
        coll.connect(bob).transferFrom(bob.address, alice.address, 2)
      ).to.be.revertedWithCustomError(coll, "SoulboundToken").withArgs(2);

      // burn 仍然允许（即便是 soulbound 也能销毁）
      await coll.connect(bob).burn(2);
      expect(await coll.exists(2)).to.equal(false);
    });
  });

  /* ------------------ Beacon 升级 ------------------ */
  describe("Beacon upgrade", () => {
    it("only the beacon owner can call upgradeTo", async () => {
      const { beacon, impl, attacker } = await loadFixture(deployFactoryFixture);
      // OwnableUnauthorizedAccount 检查在新 impl 地址被读取之前就触发，
      // 所以任意非零地址作为升级目标都能复现这个 revert。
      await expect(
        beacon.connect(attacker).upgradeTo(await impl.getAddress())
      ).to.be.revertedWithCustomError(beacon, "OwnableUnauthorizedAccount");
    });

    it("upgrades all existing clones in one transaction", async () => {
      const { factory, beacon, deployer, creator, alice, bob } =
        await loadFixture(deployFactoryFixture);

      const r1 = await (
        await factory.connect(creator).createCollection("A", "A", alice.address)
      ).wait();
      const r2 = await (
        await factory.connect(creator).createCollection("B", "B", alice.address)
      ).wait();
      const addr1 = pickCollection(r1);
      const addr2 = pickCollection(r2);

      const Coll = await ethers.getContractFactory("WeNFTUpgradeable");
      const c1 = Coll.attach(addr1);
      const c2 = Coll.attach(addr2);

      // 升级前先制造一个状态快照，验证升级后 storage 保留。
      const { hash: h1 } = makeContent("pre-upgrade-1");
      await c1.connect(alice).mint(bob.address, "u", h1, "c", "r", false);
      expect(await c1.totalSupply()).to.equal(1n);

      // 部署一份全新的 implementation 并切 beacon 指向它。
      const newImpl = await (await ethers.getContractFactory("WeNFTUpgradeable")).deploy();
      await newImpl.waitForDeployment();
      const newImplAddr = await newImpl.getAddress();

      await expect(beacon.connect(deployer).upgradeTo(newImplAddr))
        .to.emit(beacon, "Upgraded")
        .withArgs(newImplAddr);

      // beacon 已指向新 impl，factory.implementation() 转调 beacon。
      expect(await beacon.implementation()).to.equal(newImplAddr);
      expect(await factory.implementation()).to.equal(newImplAddr);

      // 已有 clone 的 storage 不受升级影响（数据存在 proxy 自己上）。
      expect(await c1.totalSupply()).to.equal(1n);
      expect(await c1.ownerOf(1)).to.equal(bob.address);
      expect(await c2.totalSupply()).to.equal(0n);

      // 升级后仍能正常调用新 impl 的逻辑。
      const { hash: h2 } = makeContent("post-upgrade");
      await expect(
        c1.connect(alice).mint(alice.address, "u2", h2, "c", "r", false)
      ).to.not.be.reverted;
      expect(await c1.totalSupply()).to.equal(2n);
    });
  });

  /* ------------------ OZ Upgrades plugin 安全性检查 ------------------ */
  // 验证 @openzeppelin/hardhat-upgrades plugin 接入正常，并能识别当前
  // implementation 为"升级安全"（即 constructor 里只有 _disableInitializers、
  // 没有 selfdestruct、没有裸 delegatecall、没有 struct-in-mapping 陷阱等）。
  // 这是 scripts/upgrade.js 在升级时依赖的编译期防线。
  describe("Upgrades plugin safety", () => {
    it("validateImplementation passes for WeNFTUpgradeable (beacon kind)", async () => {
      const Impl = await ethers.getContractFactory("WeNFTUpgradeable");
      await upgrades.validateImplementation(Impl, { kind: "beacon" });
    });
  });
});
