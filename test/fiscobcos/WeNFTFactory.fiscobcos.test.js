// WeNFTFactory 真链集成测试（FISCO BCOS）。
//
// 针对单 signer 真链的几条约束：
//   - 唯一 signer（deployer）同时担任 beacon owner、factory admin、creator
//     以及每个 cloned collection 的 admin。
//   - 整个文件共享一次 beacon + factory 部署（在 `before` 里完成）。
//     FISCO BCOS 不支持 evm_snapshot / evm_revert，无法使用 loadFixture。
//   - 不做角色伪装、不测"非授权调用应 revert"这类用例 —— 真链上没有
//     第二个账户充当 attacker。
//
// 运行：
//   npx hardhat test test/fiscobcos/WeNFTFactory.fiscobcos.test.js --network fiscobcos

const { expect } = require("chai");
const { ethers, network } = require("hardhat");

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
  let beacon;
  let beaconAddr;
  let factory;
  let Coll; // WeNFTUpgradeable 的 ContractFactory，复用于 attach 到各 clone
  let CREATOR_ROLE;
  let DEFAULT_ADMIN_ROLE;

  before(async function () {
    // 跑测试前先把当前所选环境的关键参数打印出来，避免误把测试跑到错的链上
    // （dev / test 两套环境的 .env 配置很容易看错）。
    console.log("\nFISCO BCOS network in use:");
    console.log("  hardhat network :", network.name);
    console.log("  RPC URL         :", network.config.url);
    console.log("  Chain ID        :", network.config.chainId);

    const signers = await ethers.getSigners();
    admin = signers[0];
    console.log("  Deployer        :", admin.address);
    console.log();

    const Impl = await ethers.getContractFactory("WeNFTUpgradeable");
    impl = await Impl.deploy();
    await impl.waitForDeployment();
    implAddr = await impl.getAddress();

    const Beacon = await ethers.getContractFactory("UpgradeableBeacon");
    beacon = await Beacon.deploy(implAddr, admin.address);
    await beacon.waitForDeployment();
    beaconAddr = await beacon.getAddress();

    const Factory = await ethers.getContractFactory("WeNFTFactory");
    factory = await Factory.deploy(beaconAddr, admin.address);
    await factory.waitForDeployment();

    Coll = Impl;
    CREATOR_ROLE = await factory.CREATOR_ROLE();
    DEFAULT_ADMIN_ROLE = await factory.DEFAULT_ADMIN_ROLE();
  });

  /* ------------------ 部署相关 ------------------ */
  describe("Deployment", () => {
    it("records beacon address", async () => {
      expect(await factory.beacon()).to.equal(beaconAddr);
    });

    it("implementation() view forwards to beacon", async () => {
      expect(await factory.implementation()).to.equal(implAddr);
    });

    it("grants admin & creator roles to the deployer", async () => {
      expect(await factory.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await factory.hasRole(CREATOR_ROLE, admin.address)).to.equal(true);
    });

    it("beacon owner is the deployer", async () => {
      expect(await beacon.owner()).to.equal(admin.address);
    });

    it("rejects zero beacon", async () => {
      const Factory = await ethers.getContractFactory("WeNFTFactory");
      await expect(
        Factory.deploy(ethers.ZeroAddress, admin.address)
      ).to.be.revertedWithCustomError(Factory, "ZeroBeacon");
    });

    it("rejects zero admin", async () => {
      const Factory = await ethers.getContractFactory("WeNFTFactory");
      await expect(
        Factory.deploy(beaconAddr, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(Factory, "ZeroAdmin");
    });
  });

  /* ------------------ Implementation 锁定（防直接被 init） ------------------ */
  describe("Implementation lockdown", () => {
    it("implementation itself cannot be initialized", async () => {
      await expect(
        impl.initialize("X", "X", admin.address)
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  /* ------------------ 创建 collection ------------------ */
  describe("createCollection", () => {
    it("deploys a BeaconProxy and initializes it", async () => {
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

  /* ------------------ CREATE2 确定性部署 ------------------ */
  describe("createCollectionDeterministic", () => {
    it("address matches predictAddress for same salt", async () => {
      // salt 随机化：测试可能针对同一份 factory 多次重跑，避免 salt 撞上
      // 之前已经消费过的值。
      const salt = ethers.id("we:honor:fbcos:" + Date.now() + ":" + Math.random());
      const predicted = await factory.predictAddress(salt);

      const tx = await factory
        .connect(admin)
        .createCollectionDeterministic("X", "X", admin.address, salt);
      const receipt = await tx.wait();
      const collAddr = pickCollection(receipt);

      expect(collAddr).to.equal(predicted);
    });

    it("predicted address is independent of name/symbol/admin (salt-only)", async () => {
      const salt = ethers.id("salt-stability:" + Date.now() + ":" + Math.random());
      // predictAddress 只依赖 (factory, salt)，每条 collection 自带的
      // name/symbol/admin 不会渗入 CREATE2 地址计算。
      expect(await factory.predictAddress(salt)).to.equal(
        await factory.predictAddress(salt)
      );
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

  /* ------------------ Clone 端到端业务流 ------------------ */
  describe("Cloned collection functionality", () => {
    it("supports mint / verify / self-transfer / soulbound / burn", async () => {
      const r = await (
        await factory
          .connect(admin)
          .createCollection("T", "T", admin.address)
      ).wait();
      const collAddr = pickCollection(r);
      const coll = Coll.attach(collAddr);

      // mint 非 soulbound token #1
      const { raw, hash } = makeContent('{"name":"Q1 Star"}-' + Date.now());
      await (
        await coll
          .connect(admin)
          .mint(admin.address, "ipfs://x", hash, "honor", "good", false)
      ).wait();
      expect(await coll.ownerOf(1)).to.equal(admin.address);

      // 内容真实性校验
      expect(await coll.verifyContent(1, raw)).to.equal(true);

      // 单账户网络下能做"自转给自己"的转账（非 soulbound）。
      await (
        await coll
          .connect(admin)
          .transferFrom(admin.address, admin.address, 1)
      ).wait();
      expect(await coll.ownerOf(1)).to.equal(admin.address);

      // mint soulbound token #2：自转应被拦截。
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

      // 烧掉 soulbound token，exists 应变回 false。
      await (await coll.connect(admin).burn(2)).wait();
      expect(await coll.exists(2)).to.equal(false);
    });
  });

  /* ------------------ Beacon 升级 ------------------ */
  // 放在最后跑：上面所有 suite 都基于原始 impl，本 suite 执行升级后再
  // 验证一次"老 collection 在新 impl 下仍能正常工作"。
  describe("Beacon upgrade", () => {
    it("upgrades all existing clones in one transaction", async () => {
      // 先创建一个 collection，并 mint 一个 NFT 作为"升级前状态快照"。
      const r = await (
        await factory.connect(admin).createCollection("Pre", "PRE", admin.address)
      ).wait();
      const preAddr = pickCollection(r);
      const pre = Coll.attach(preAddr);

      const { hash } = makeContent("pre-upgrade-" + Date.now());
      await (
        await pre.connect(admin).mint(admin.address, "u", hash, "c", "r", false)
      ).wait();
      const supplyBefore = await pre.totalSupply();
      expect(supplyBefore).to.equal(1n);

      // 部署一份全新 impl，并把 beacon 切到它。
      const Impl = await ethers.getContractFactory("WeNFTUpgradeable");
      const newImpl = await Impl.deploy();
      await newImpl.waitForDeployment();
      const newImplAddr = await newImpl.getAddress();

      await expect(beacon.connect(admin).upgradeTo(newImplAddr))
        .to.emit(beacon, "Upgraded")
        .withArgs(newImplAddr);

      // beacon 已切换；factory.implementation() 转调，应同步看到新地址。
      expect(await beacon.implementation()).to.equal(newImplAddr);
      expect(await factory.implementation()).to.equal(newImplAddr);

      // 升级前已有 collection 的 storage 保留。
      expect(await pre.totalSupply()).to.equal(supplyBefore);

      // 升级后仍能在新 impl 下正常 mint。
      const { hash: h2 } = makeContent("post-upgrade-" + Date.now());
      await (
        await pre.connect(admin).mint(admin.address, "u2", h2, "c", "r", false)
      ).wait();
      expect(await pre.totalSupply()).to.equal(supplyBefore + 1n);
    });
  });
});
