# NFT 合约标准全景图

> Web3 里"NFT 标准"不是单一标准，而是**以 ERC-721 为核心 + 一系列扩展和替代标准组成的家族**。本文档按层次梳理整个生态。

## 一、整体架构

```
                    ERC-165（接口检测，所有标准的基石）
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   ERC-721            ERC-1155          其他特殊标准
  （NFT 核心）        （多代币标准）         （SBT, TBA 等）
        │
   ┌────┼────┬─────────┬─────────┬─────────┐
   ▼    ▼    ▼         ▼         ▼         ▼
 Meta- Enum- Receiver  4906     2981      其他
 data  erable          (元更新)  (版税)
```

## 二、ERC-165（接口检测协议）

**所有标准的"身份证"**

| 项目 | 内容 |
|---|---|
| 作者 | Christian Reitwießner、Nick Johnson 等 |
| 通过时间 | 2018-01 |
| 作用 | 让任何合约能在链上声明"我支持哪些接口"，让外部代码能预检合约能力 |

### 唯一方法

```solidity
function supportsInterface(bytes4 interfaceId) external view returns (bool);
```

`interfaceId` 是接口所有方法 selector 的 XOR。每个标准有自己的 interfaceId（4 字节）。

## 三、ERC-721（NFT 核心标准）

| 项目 | 内容 |
|---|---|
| 作者 | William Entriken、Dieter Shirley、Jacob Evans、Nastassia Sachs |
| 通过时间 | 2018-06 |
| 接口 ID | `0x80ac58cd` |
| 核心属性 | 每个 token 独一无二，由 256 位 tokenId 唯一标识，单 token 不可分割 |

### 必须实现的方法（共 9 个）

| 方法 | 类型 | 作用 |
|---|---|---|
| `balanceOf(address owner)` | view | 返回某地址拥有的 NFT 数量 |
| `ownerOf(uint256 tokenId)` | view | 返回某 NFT 的所有者 |
| `safeTransferFrom(from, to, tokenId)` | tx | 安全转账（检查 receiver） |
| `safeTransferFrom(from, to, tokenId, data)` | tx | 安全转账带额外数据 |
| `transferFrom(from, to, tokenId)` | tx | 转账（不检查 receiver，**慎用**） |
| `approve(address to, uint256 tokenId)` | tx | 授权某地址转移单个 token |
| `setApprovalForAll(address operator, bool approved)` | tx | 全局授权某地址转移自己所有 NFT |
| `getApproved(uint256 tokenId)` | view | 查询某 token 被授权给谁 |
| `isApprovedForAll(address owner, address operator)` | view | 查询是否设置了全局授权 |

### 必须 emit 的事件（3 个）

| 事件 | 触发时机 |
|---|---|
| `Transfer(from, to, tokenId)` | mint（from=0）/ transfer / burn（to=0） |
| `Approval(owner, approved, tokenId)` | 单 token 授权变更 |
| `ApprovalForAll(owner, operator, approved)` | 全局授权变更 |

### 关键设计点

- **`safeTransferFrom` vs `transferFrom`**：safe 版本会检查 `to` 如果是合约必须实现 `IERC721Receiver`，否则 revert——避免 NFT 黑洞
- **授权两层**：单 token 授权 + 全局 operator 授权，市场（OpenSea）依赖后者
- **Transfer 事件 from=0 表示 mint**：约定俗成，很多索引服务依赖这点

## 四、ERC-721 Metadata（元数据扩展）

| 项目 | 内容 |
|---|---|
| 接口 ID | `0x5b5e139f` |
| 作用 | 让 NFT 有名字、符号、可读元数据 URL |

### 三个方法

| 方法 | 作用 |
|---|---|
| `name()` | 集合名称（"WeNFT", "Bored Ape Yacht Club"） |
| `symbol()` | 集合简称（"WNFT", "BAYC"） |
| `tokenURI(uint256 tokenId)` | 返回该 token 元数据 JSON 的 URL |

`tokenURI` 返回值通常指向 IPFS 或 HTTPS 服务器上的 JSON：

```json
{
  "name": "Token #1",
  "description": "...",
  "image": "ipfs://QmXxx.../1.png",
  "attributes": [
    { "trait_type": "Background", "value": "Blue" }
  ]
}
```

## 五、ERC-721 Enumerable（可枚举扩展）

| 项目 | 内容 |
|---|---|
| 接口 ID | `0x780e9d63` |
| 作用 | 让链上可以列出"全部 token"或"某用户的所有 token"——标准 ERC-721 做不到 |

### 三个方法

| 方法 | 作用 |
|---|---|
| `totalSupply()` | 当前流通的 NFT 总数 |
| `tokenByIndex(uint256 index)` | 按全局索引取 tokenId |
| `tokenOfOwnerByIndex(address owner, uint256 index)` | 按某地址持有索引取 tokenId |

**代价**：每次 mint/transfer/burn 多写约 4 个 storage 槽（约 +80000 gas）。

## 六、ERC-721 Receiver（接收方校验接口）

| 项目 | 内容 |
|---|---|
| 接口 ID | `0x150b7a02` |
| 作用 | 合约要接收 NFT 必须实现这个接口，否则 `safeTransferFrom` 会 revert |

### 唯一方法

```solidity
function onERC721Received(
    address operator,
    address from,
    uint256 tokenId,
    bytes calldata data
) external returns (bytes4);
```

**返回值要求**：必须返回 `IERC721Receiver.onERC721Received.selector`（即 `0x150b7a02`），否则 `safeTransferFrom` 认为接收方不接受这个 NFT，revert。

> 这是给"接收方合约"实现的，不是给 NFT 合约本身实现的。NFT 合约的 `safeTransferFrom` 内部会调它。

## 七、ERC-4906（元数据更新通知）

| 项目 | 内容 |
|---|---|
| 作者 | Brian Quinlan、John Liu |
| 通过时间 | 2022-09 |
| 接口 ID | `0x49064906` |
| 作用 | 让 OpenSea/钱包等自动刷新元数据缓存 |

### 两个事件（**没有方法**，纯事件标准）

| 事件 | 触发时机 |
|---|---|
| `MetadataUpdate(uint256 tokenId)` | 单个 token 元数据变更 |
| `BatchMetadataUpdate(uint256 fromId, uint256 toId)` | 范围内批量变更 |

OpenSea 等市场监听这俩事件，自动重抓 `tokenURI`。

## 八、ERC-2981（NFT 版税标准）

| 项目 | 内容 |
|---|---|
| 作者 | Zach Burks 等 |
| 通过时间 | 2020-09 |
| 接口 ID | `0x2a55205a` |
| 作用 | NFT 合约链上声明"二级市场每次成交，多少比例付给谁" |

### 一个方法

```solidity
function royaltyInfo(uint256 tokenId, uint256 salePrice)
    external view returns (address receiver, uint256 royaltyAmount);
```

> **注意**：ERC-2981 只是声明意图，**不强制**市场执行。OpenSea 已多次声明对该标准"软支持"（可被买家关闭）。链上版税本质不可强制，是协议层无奈。

## 九、ERC-1155（多代币标准）

| 项目 | 内容 |
|---|---|
| 作者 | Witek Radomski、Andrew Cooke 等（Enjin 团队） |
| 通过时间 | 2019-06 |
| 接口 ID | `0xd9b67a26` |
| 定位 | ERC-721 的替代品 / 互补品 |

**核心特点**：一个合约里可以同时管理多种代币，每种可以是 NFT（数量=1）或半同质化（数量>1）。

### 核心方法

| 方法 | 作用 |
|---|---|
| `balanceOf(address account, uint256 id)` | 某账户持有某 id 代币的数量 |
| `balanceOfBatch(accounts[], ids[])` | 批量查询余额 |
| `safeTransferFrom(from, to, id, amount, data)` | 转账某种代币若干个 |
| `safeBatchTransferFrom(...)` | 批量转账多种代币 |
| `setApprovalForAll(operator, approved)` | 全局授权 |
| `isApprovedForAll(owner, operator)` | 查询全局授权 |
| `uri(uint256 id)` | 返回某 id 的元数据 URI |

### 事件

```solidity
event TransferSingle(operator, from, to, id, value);
event TransferBatch(operator, from, to, ids[], values[]);
event ApprovalForAll(account, operator, approved);
event URI(string value, uint256 id);
```

### 与 ERC-721 的对比

| 维度 | ERC-721 | ERC-1155 |
|---|---|---|
| 一个合约能管几种 token | 1 种集合 | 任意多种 |
| token 数量 | 每个 1（唯一） | 可任意（同一 id 可有 N 份） |
| 批量转账 | 没有原生支持 | 一笔 tx 转多种多个 |
| 适合场景 | 头像、数字藏品、不动产 | 游戏道具、卡牌、半同质化资产 |
| Gas（单次转） | 较低 | 略高 |
| Gas（批量转） | 高（要发多笔 tx） | **极低**（一笔搞定） |

### 典型场景对比

- **头像项目（PFP）** → ERC-721（每个独一无二）
- **游戏装备（武器、药水各 100 把）** → ERC-1155（半同质化）
- **会员凭证（多等级）** → ERC-1155 更省 gas

## 十、SBT 相关标准（灵魂绑定）

### ERC-5114（Soulbound Badge）—— Stagnant

- 作者：Micah Zoltu
- 特点：mint 后**绝对不可转让也不可销毁**
- 状态：过于刚硬，未广泛采用

### ERC-5484（Consensual SBT）—— Final

- 通过时间：2022-08
- 接口 ID：`0xa511533d`
- 核心创新：mint 时由发行方选定"谁有 burn 权"

```solidity
enum BurnAuth { IssuerOnly, OwnerOnly, Both, Neither }

event Issued(
    address indexed from,
    address indexed to,
    uint256 indexed tokenId,
    BurnAuth burnAuth
);

function burnAuth(uint256 tokenId) external view returns (BurnAuth);
```

业务里很灵活：

| 场景 | BurnAuth | 含义 |
|---|---|---|
| 学历证书 | `IssuerOnly` | 学校能撤 |
| 个人成就 | `OwnerOnly` | 用户能扔 |
| 工作经历 | `Both` | 双方都能终止 |
| 永久荣誉 | `Neither` | 任何人不能销毁 |

## 十一、其他重要的 NFT 衍生标准

### ERC-6551（NFT-bound Accounts，TBA）

- 通过时间：2023
- 核心：每个 NFT 自己**就是一个智能账户**——可以持有其他代币、签名、调外部合约
- 价值：让 NFT 从"被动资产"变成"主动 agent"

```solidity
// TBA Registry 提供
function account(implementation, chainId, tokenContract, tokenId, salt) returns (address);
function createAccount(...) returns (address);
```

应用：游戏角色 NFT 自己持有装备 NFT，转让角色时装备一起转。

### ERC-721A（Azuki 优化版本，**非正式 EIP**）

- 作者：Azuki 团队
- 核心：批量 mint 极致优化——一次 mint N 个，gas 接近一次 mint 1 个的成本
- 做法：lazy ownership 模式 —— 只为第一个 token 写所有者，后续 N-1 个的 ownerOf 在查询时沿 tokenId 向前回溯
- 代价：`ownerOf` 查询变贵；`balanceOf` 仍精确；ERC-721 标准接口完全兼容
- 适合：大规模 PFP 项目（5000-10000 张一次性发售）

### ERC-2309（Consecutive Transfer）

- 作者：Sean Papanikolas
- 通过时间：2020
- 核心：批量 mint/转移时用一个事件代替 N 个 Transfer 事件，省 gas，给链下索引方便

### ERC-4400 / ERC-4907（NFT 租赁）

核心：在 NFT 上加"使用者"和"所有者"二分概念，让 NFT 可被短期租赁而不转移所有权。

| 标准 | 重点 |
|---|---|
| ERC-4400 | 同时维护 owner 和 user，user 有过期时间 |
| ERC-4907 | 简化版，单 user + 过期 |

适合：游戏道具租赁、虚拟土地短租。

### ERC-7066（Lockable NFT）

核心：所有者可以**锁定**自己的 NFT 防止意外转移（比如签了恶意签名时仍然安全）。

## 十二、本项目（WeNFT）实现的标准汇总

| 标准 | 类型 | 作用 | WeNFT 是否实现 |
|---|---|---|---|
| ERC-165 | 基础 | 接口检测 | ✅ |
| ERC-721 | 核心 | NFT 基本能力 | ✅ |
| ERC-721 Metadata | 扩展 | name/symbol/tokenURI | ✅ |
| ERC-721 Enumerable | 扩展 | 可枚举 | ✅ |
| ERC-721 Receiver | 扩展 | 接收方校验 | ✅（safeMint 触发） |
| ERC-4906 | 扩展 | 元数据更新通知 | ✅（继承 URIStorage 自动支持） |
| ERC-2981 | 扩展 | 链上版税 | ❌（如需可加） |
| ERC-5484 | 扩展 | SBT 标准 | ❌（用了自定义 bool 字段） |
| ERC-1155 | 替代 | 多代币 | ❌（不同范式） |
| ERC-6551 | 扩展 | NFT-bound 账户 | ❌（高级特性） |
| ERC-721A | 优化 | 批量 mint 省 gas | ❌（用 OZ 标准实现） |

## 十三、典型 NFT 合约的方法骨架

把上面所有标准核心方法汇总成"一个完整 NFT 合约可能暴露的方法清单"：

```solidity
// === ERC-165 ===
supportsInterface(bytes4) → bool

// === ERC-721 核心 ===
balanceOf(address) → uint256
ownerOf(uint256) → address
safeTransferFrom(address, address, uint256)
safeTransferFrom(address, address, uint256, bytes)
transferFrom(address, address, uint256)
approve(address, uint256)
setApprovalForAll(address, bool)
getApproved(uint256) → address
isApprovedForAll(address, address) → bool

// === ERC-721 Metadata ===
name() → string
symbol() → string
tokenURI(uint256) → string

// === ERC-721 Enumerable ===
totalSupply() → uint256
tokenByIndex(uint256) → uint256
tokenOfOwnerByIndex(address, uint256) → uint256

// === ERC-2981 版税（可选）===
royaltyInfo(uint256, uint256) → (address, uint256)

// === 业务自定义（mint, burn, etc.）===
mint(...) → uint256
batchMint(...) → uint256[]
burn(uint256)
// ...
```

## 十四、选型建议——什么场景选什么标准

| 业务 | 推荐标准 | 理由 |
|---|---|---|
| 头像 / 数字藏品 | **ERC-721 + Metadata + Enumerable** | 标准玩法 |
| 大规模 PFP（万张以上）| ERC-721A + 上述扩展 | 省巨额 mint gas |
| 游戏道具 / 卡牌 | **ERC-1155** | 半同质化、批量友好 |
| 学历 / 资格证书 | ERC-721 + ERC-5484 | SBT 不可转让 |
| 创作者版税 | + ERC-2981 | 但效果取决于市场是否尊重 |
| 元数据需要可更新 | + ERC-4906 | 让市场自动刷缓存 |
| 角色身份系统 | ERC-721 + ERC-6551 | NFT 自带账户 |
| NFT 租赁市场 | ERC-721 + ERC-4907 | 所有权与使用权分离 |

## 十五、一句话总结

**NFT 合约标准家族 = ERC-165（基础）+ ERC-721（核心 9 个方法 + 3 个事件）+ 系列可选扩展（Metadata / Enumerable / 4906 / 2981 / 5484 / 6551 等）**；ERC-1155 是平行的多代币方案，不是 ERC-721 的扩展而是替代品。

**WeNFT 选择 ERC-721 + Metadata + Enumerable + URIStorage + Pausable + Burnable + AccessControl，加上自定义的 `soulbound` 字段——这是企业级 NFT 模板的"标准全家桶"配置**。

## 参考资源

- [Ethereum EIPs Index](https://eips.ethereum.org/)
- [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts/)
- [ERC-721 标准原文](https://eips.ethereum.org/EIPS/eip-721)
- [ERC-1155 标准原文](https://eips.ethereum.org/EIPS/eip-1155)
- [ERC-4906 标准原文](https://eips.ethereum.org/EIPS/eip-4906)
- [ERC-5484 标准原文](https://eips.ethereum.org/EIPS/eip-5484)
- [ERC-6551 标准原文](https://eips.ethereum.org/EIPS/eip-6551)
