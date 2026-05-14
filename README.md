# WeNFT（FISCO BCOS 3.x）

We 抽奖平台的通用 NFT 合约模板。每个 collection 都是一个独立的 ERC721
（自己的 name/symbol/admin/规则），可用于任何业务线 —— 公司荣誉徽章、
盲盒、第三方平台 NFT 等。面向 FISCO BCOS 3.x（兼容 EVM）部署，单元
测试通过 Hardhat 内置网络运行。

合约通过 **Beacon-proxy 工厂** 创建：implementation + UpgradeableBeacon
+ WeNFTFactory 部署一次后，每条新业务线只需要一次 `createCollection`
调用（约 ~90k gas）。所有 clone 共享同一份 implementation，平台
统一升级（一笔 `beacon.upgradeTo` 让所有 collection 同时切换到新
逻辑），同时各 collection 的 storage（mint 记录、余额、role 状态等）
完全独立、互不影响。

## 架构总览

```
        ┌──────────────────────┐
        │  UpgradeableBeacon   │  ← owner 调 upgradeTo(newImpl)
        │   implementation     │     生产环境应是 timelock/多签合约
        └─────────┬────────────┘
                  │  IBeacon.implementation()
        ┌─────────┼─────────┬─────────┐
        │         │         │         │
        ▼         ▼         ▼         ▼
   BeaconProxy ... BeaconProxy   每个 clone 调用时都向 beacon 查询
   collection-1    collection-N   当前 impl 地址，再 DELEGATECALL
        ▲                 ▲
        │  createCollection / createCollectionDeterministic
        │
   ┌────┴────────┐
   │ WeNFTFactory│  ← AccessControl：DEFAULT_ADMIN_ROLE / CREATOR_ROLE
   └─────────────┘
```

权责拆分：
- **Beacon owner**：升级权所有者，控制"对全部 collection 一次性升级"。
- **Factory admin**（`DEFAULT_ADMIN_ROLE`）：管理 `CREATOR_ROLE` 授予/撤销。
- **Creator**（`CREATOR_ROLE`）：可调用 `createCollection*` 部署新的
  collection。
- **Collection admin**（每个 clone 自身的 `DEFAULT_ADMIN_ROLE`）：在
  collection 内部管理 mint / pauser 等角色。

## 合约能力

- ERC721 + Enumerable + URIStorage + Pausable + Burnable + AccessControl
- 三个角色：`DEFAULT_ADMIN_ROLE`、`MINTER_ROLE`、`PAUSER_ROLE`
- 单 `mint` 与 `batchMint`，每个 token 携带元数据
  （`category`、`reason`、`issuer`、`issuedAt`、`contentHash`、
  `schemaVersion`、`soulbound`）
- **链上内容真实性锚定**：`contentHash` = keccak256(规范化后的链下元数据
  字节)，配套 `verifyContent` view 校验
- **每个 token 独立 soulbound 标志**：同一份合约既可发行可转让的收藏品，
  也可发行不可转让的荣誉凭证
- 管理员可修复 URI/hash（`updateTokenURI`），同时触发 ERC-4906 的
  `MetadataUpdate` 标准事件 + 自定义 `NFTMetadataUpdated`（带新旧 hash）
- 每 token 快照 schema 版本（`schemaVersion`），便于链下解码器识别版本
- 查询：`ownerOf`、`balanceOf`、`tokenURI`、`totalSupply`、`getNFTInfo`、
  `tokensOf`、`exists`、`isSoulbound`、`nextTokenId`
- 紧急 `pause` / `unpause`
- CREATE2 确定性部署：`createCollectionDeterministic` 配合 `predictAddress`
  预计算地址。地址只依赖 `(factory, salt)`，与 name/symbol/admin 无关
  —— factory 内部以"空 initData 部署 BeaconProxy → 再 initialize"两步
  原子完成
- **Beacon 驱动的升级能力**：一笔 `beacon.upgradeTo(newImpl)` 让所有
  存量 collection 同时切到新 impl，storage 不丢失

## 项目结构

```
contracts/
  WeNFTUpgradeable.sol            # 可克隆的 collection 业务合约（被 clone）
  WeNFTFactory.sol                # Beacon-proxy 工厂
test/
  WeNFTFactory.test.js            # Hardhat 网络单测（含 plugin 接入校验）
  fiscobcos/
    WeNFTFactory.fiscobcos.test.js  # 真链集成测试
scripts/
  deploy.js                       # 一键部署 impl + beacon + factory（用 plugin）
  upgrade.js                      # 升级新 impl + beacon.upgradeTo（带 layout 校验）
  interact.js                     # 端到端 smoke 流程，含升级演示
  extract-artifacts.js            # 导出 ABI/bytecode 给 fisco bcos console 使用
hardhat.config.js                 # solidity 0.8.22，evmVersion paris
```

## 快速开始

```bash
pnpm install        # 或 npm install
npx hardhat compile
npx hardhat test
```

可选 coverage：

```bash
npx hardhat coverage
```

## 在本地 Hardhat 节点部署

```bash
npx hardhat node                       # 终端 A
pnpm deploy:local                      # 终端 B
```

部署完成后，每条新 collection 只需一笔交易：

```js
const factory = await ethers.getContractAt("WeNFTFactory", FACTORY_ADDR);
const tx = await factory.createCollection("Mystery Box", "MBOX", adminAddr);
// 新 collection 地址在 CollectionCreated 事件里
```

## 部署到 FISCO BCOS 3.x

项目同时支持两套 FISCO BCOS 环境（开发节点 / 测试节点），命令名通过
`:dev` / `:test` 后缀直接区分，不用切换环境变量：

| 操作 | 开发环境（dev） | 测试环境（test） |
|---|---|---|
| 部署 | `pnpm deploy:fiscobcos:dev` | `pnpm deploy:fiscobcos:test` |
| 升级 | `pnpm upgrade:fiscobcos:dev` | `pnpm upgrade:fiscobcos:test` |
| 跑集成测试 | `pnpm test:fiscobcos:dev` | `pnpm test:fiscobcos:test` |

底层对应 hardhat 网络 `fiscobcos-dev` / `fiscobcos-test`，两者各读自己的
环境变量分组。请按 `.env.example` 在 `.env` 里填写：

```
# --- 开发环境 (dev) ---
FISCOBCOS_DEV_RPC_URL=http://<dev-node>:<port>
FISCOBCOS_DEV_CHAIN_ID=20200
FISCOBCOS_DEV_PRIVATE_KEY=0x...

# --- 测试环境 (test) ---
FISCOBCOS_TEST_RPC_URL=http://<test-node>:<port>
FISCOBCOS_TEST_CHAIN_ID=20200
FISCOBCOS_TEST_PRIVATE_KEY=0x...
```

两组只填一组也可以（只用某一套环境时，未配的那组留默认值就行 ——
hardhat 不会在你不调用对应 `--network` 时实例化它）。

可选的部署 / 升级参数（由 `scripts/deploy.js` 和 `scripts/upgrade.js`
读取，不区分环境）：

```
BEACON_OWNER=0x...                 # 升级权所有者，不设则用 deployer
FACTORY_ADMIN=0x...                # factory 创建权管理员，不设则用 deployer
BEACON_ADDR=0x...                  # 升级时必填；按当前 --network 对应环境填
```

> **生产环境强烈建议** 把 `BEACON_OWNER` 设为 timelock 或多签合约地址，
> 而不是 EOA：拿到 beacon owner 私钥的人可以一笔交易替换所有 collection
> 背后的实现合约。

> **`BEACON_ADDR` 注意**：dev 和 test 各部署一份独立的 beacon，地址不同。
> 跑 `upgrade:fiscobcos:dev` 时填 dev 的 beacon 地址；跑 `:test` 时填
> test 的 beacon 地址。建议在 `.env` 里维护两个变量（如 `BEACON_ADDR_DEV`、
> `BEACON_ADDR_TEST`），运行 upgrade 时再 `BEACON_ADDR=$BEACON_ADDR_DEV
> pnpm upgrade:fiscobcos:dev` 注入。

> 提示：生产环境部署 FISCO BCOS 时也可以用官方的 `fisco-bcos-sdk`
> (Java/Go/Node) 或 `console` 工具。这里的 Hardhat profile 是为了
> 与单测保持一致、方便开发联调，本身不限制最终的部署工具链。

---

# 升级原理与操作

## 一、Beacon 升级的底层原理

### 名词解释：beacon = 灯塔

一个合约（beacon）持有"当前 implementation 地址"，所有 BeaconProxy
都向它询问"该 delegatecall 到哪个 impl"。改一处灯塔，所有船同时换
航线 —— 这就是名字的由来。EIP-1967 正式把这种模式标准化，定义了
`_BEACON_SLOT` 用来在 proxy 内存储 beacon 地址。

### 数据通路（每次调用都走这条）

```
caller
  │ calldata
  ▼
BeaconProxy ── staticcall ──▶ Beacon.implementation()    ← 返回当前 impl 地址
  │
  │ delegatecall(impl, calldata)
  ▼
Implementation (逻辑代码)
  │ reads/writes storage
  ▼
storage 保存在 BeaconProxy 自身的合约地址下，与 impl 无关
```

两条关键设计：
1. **proxy 不存 impl 地址**，只存 beacon 地址 → 改一处 beacon，所有
   proxy 立即跟随
2. **storage 在 proxy 自身** → 换 impl 不丢数据

### 升级通路（一笔交易完成）

```
beacon-owner
  │
  ▼
Beacon.upgradeTo(newImpl) ── 修改 beacon 内部的 _implementation
                              ↓
                              所有 BeaconProxy 在下一次调用时立即看到新地址
```

### 升级影响范围矩阵

| 部件 | 升级时是否变化 | 原因 |
|---|---|---|
| 每个 collection 的**地址** | ❌ 不变 | 调用方 / 数据库 / 链下索引器存的地址不动 |
| 每个 collection 的 **storage** | ❌ 不变 | 数据存在 BeaconProxy 自身，不在 implementation |
| **Beacon** 合约 | ❌ 不变 | 它只是个持有 impl 指针的合约 |
| **Factory** 合约 | ❌ 不变 | 它只持有 beacon 地址 |
| **Implementation** 合约 | ✅ 部署一份新的 | 这是承载业务逻辑的合约 |

### 升级不能做的事（务必了解）

1. **不能改 constructor 行为**：BeaconProxy 永远不会执行 implementation
   的 constructor，[contracts/WeNFTUpgradeable.sol](contracts/WeNFTUpgradeable.sol)
   里那个 `constructor() { _disableInitializers(); }` 只在 implementation
   合约**自身**被部署时跑一次，对 BeaconProxy 完全无效。
2. **不能给已存在的 collection 重新 initialize**：每个 BeaconProxy 创建时
   已经走过 `initialize`，`initializer` 修饰符会防止二次调用。若新版本
   需要初始化新字段，应该加一个 `reinitializer(2)` 函数，由 collection
   admin 在升级后逐个调用。
3. **不能改 storage layout**：详见下一节。

## 二、storage layout 兼容性铁律

升级最危险的雷区。**新版 implementation 的 storage 变量只能在末尾追加**，
不能：

- 删除已有 storage 变量
- 改变量的类型
- 调整变量声明顺序
- 在中间插入新变量

当前合约的 storage layout（[contracts/WeNFTUpgradeable.sol](contracts/WeNFTUpgradeable.sol)）：

```solidity
struct NFTInfo {
    bytes32 contentHash;   // slot 0
    uint64 issuedAt;       // slot 1 共 31B
    address issuer;
    uint16 schemaVersion;
    bool soulbound;
    string category;       // pointer slot
    string reason;         // pointer slot
}

uint256 private _nextTokenId;
uint16 public currentSchemaVersion;
mapping(uint256 => NFTInfo) private _nftInfo;
// 升级时新字段只能加在这里 ↓↓↓
```

一旦撞了 layout，新 impl 会用错误的 slot 读取数据 —— 表现可能是数据
"消失"、读到垃圾值、或者交易直接 revert，损坏不可逆。

为了把这道防线从"靠脑子记"提升为"工具自动检测"，本项目接入了
**OpenZeppelin Upgrades plugin**：
- 首次部署时（[scripts/deploy.js](scripts/deploy.js)）写一份 layout 基线
  到 `.openzeppelin/<network>.json`
- 后续升级时（[scripts/upgrade.js](scripts/upgrade.js)）调
  `upgrades.validateUpgrade` 比对基线，layout 不兼容 → **直接 abort，
  不会广播 tx**

## 三、操作流程（标准升级路径）

### 一次性部署

按目标环境选一条命令：

```bash
pnpm deploy:fiscobcos:dev     # 开发环境
pnpm deploy:fiscobcos:test    # 测试环境
# 本地 hardhat node：
pnpm deploy:local
```

`scripts/deploy.js` 内部调用 `upgrades.deployBeacon(...)` 部署
implementation + UpgradeableBeacon，并把 storage layout 基线写入
`.openzeppelin/<network>.json`（dev 和 test 各有一份 manifest）。
完成后还会手动部署 factory（factory 本身不是 proxy，不归 plugin 管）。

部署输出例：

```
Deployer: 0x...
WeNFTUpgradeable (implementation) deployed: 0xImpl...
UpgradeableBeacon deployed: 0xBeacon...
  implementation: 0xImpl...
  beacon owner  : 0x...
WeNFTFactory deployed: 0xFactory...
  beacon        : 0xBeacon...
  factory admin : 0x...
```

记录下 `0xBeacon...` 和 `0xFactory...` 两个地址。

### 升级一个新版本的 implementation

1. 编辑 [contracts/WeNFTUpgradeable.sol](contracts/WeNFTUpgradeable.sol)，
   修 bug / 加方法 / 加新 storage 字段（**只能加在末尾**）。

2. 跑升级脚本（按目标环境选 `:dev` 或 `:test`）：

   ```bash
   BEACON_ADDR=0xBeacon... pnpm upgrade:fiscobcos:dev
   # 或
   BEACON_ADDR=0xBeacon... pnpm upgrade:fiscobcos:test
   ```

   `scripts/upgrade.js` 会按顺序：
   - 读取 beacon 当前的 implementation 地址作为对比
   - 调 `upgrades.validateUpgrade(beaconAddr, NewImpl, { kind: "beacon" })`
     做 **storage layout 兼容性校验 + unsafe pattern 检测**（selfdestruct、
     裸 delegatecall、constructor 副作用等）。校验失败 → 立即 abort，
     **不会发出任何升级交易**
   - 部署新的 implementation 合约
   - 调 `beacon.upgradeTo(newImpl)` 切换指针
   - 打印新旧 impl 地址，便于审计

3. 校验：

   ```js
   await factory.implementation()   // = newImplAddr（转调 beacon 拿到）
   await beacon.implementation()    // = newImplAddr
   // 老 collection 的 storage 应该保留
   await someExistingCollection.totalSupply()
   ```

### 生产环境（beacon owner 是 timelock/多签）

`scripts/upgrade.js` 是面向"单 EOA owner"设计的，会直接调 `upgradeTo`。
当 beacon owner 是 timelock 或多签合约时，你的 signer 不是 owner，直接
调会 revert。这种情况下用 `upgrades.prepareUpgrade(...)`：

```js
const newImplAddr = await upgrades.prepareUpgrade(
  BEACON_ADDR,
  NewImpl,
  { kind: "beacon" }
);
// 它只做：layout 校验 + 部署 newImpl + 返回地址
// 然后把 beacon.upgradeTo(newImplAddr) 的调用提议交给 timelock / 多签
// 按治理流程执行
```

layout 校验逻辑跟 `upgradeBeacon` 是同一套，区别仅在于"不真的发起
upgradeTo"。

## 四、紧急回滚

升级出问题时，由于 storage 在 proxy 上不动，**回滚等价于把 beacon 切回
旧 impl 地址**：

```js
const beacon = await ethers.getContractAt("UpgradeableBeacon", BEACON_ADDR);
await beacon.upgradeTo(OLD_IMPL_ADDR);
```

只要旧 impl 合约还在链上（部署后不会消失，地址永远可达），就能立刻回滚。
建议在 deploy/upgrade 时把旧 impl 地址记入运维记录。

---

## 链上内容真实性模型

每个 NFT 锚定在 `contentHash = keccak256(raw)`，`raw` 是规范化后的
链下元数据字节序列（JCS 规范化的 JSON、IPFS DAG block、或你和发行方
约定的任何编码）。持有 `raw` 的任何一方都能验证：

```js
// 本地校验
const localHash = ethers.keccak256(rawBytes);
expect(localHash).to.equal((await coll.getNFTInfo(tokenId)).contentHash);

// 或委托节点计算
const ok = await coll.verifyContent(tokenId, rawBytes);
```

管理员通过 `updateTokenURI` 修复 URI/hash 时，旧 hash 和新 hash 都会以
`NFTMetadataUpdated` 事件 emit，审计可以完整重建历史。

## FISCO BCOS 3.x 兼容性说明

- 使用 Solidity 0.8.22 + `evmVersion: paris`。0.8.22 是最低可用版本：
  OpenZeppelin 5.1.0 的 `ERC1967Utils.sol`（被 `BeaconProxy` 间接依赖）
  要求 `^0.8.21`，而 solc 0.8.21 本身有 Natspec 相关的内部 bug，遇到
  带文档注释的合约会 crash，所以跳到 0.8.22。Paris EVM target 避免了
  `TLOAD` / `TSTORE` / `MCOPY` 这些 Cancun-only 指令 —— FISCO BCOS 3.x
  运行时还不支持。
- `@openzeppelin/contracts` 锁定在 5.1.0：5.4+ 在 `Bytes.sol` 中引入了
  内联 `mcopy`，无法在 paris 下编译。
- 合约只用 FISCO BCOS 3.x 支持的标准 EVM 特性（不依赖 `selfdestruct`、
  原生币转账、配对预编译、`BLOCKHASH` 等）。
- `block.timestamp` 与 `msg.sender` 的语义与以太坊一致。
