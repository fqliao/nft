# nft-contract-wrapper

独立 Gradle 模块，做两件事：

1. 把上层 WeNFT 项目的 Hardhat 编译产物转换成 Web3j Java wrapper（`WeNFTFactory`、`WeNFTUpgradeable`、`UpgradeableBeacon`）。
2. 提供一个轻量的 `ContractManager` 门面，按配置初始化 RPC + 签名账户，并交付即取即用的 wrapper 实例。

整体参考 `RWA-Distribution/shared/rwa-contract-wrapper` 的模式，做了独立仓库化的适配：不强依赖 Spring Boot，也不需要父级 Gradle settings。

## 目录结构

```
nft-contract-wrapper/
├── build.gradle                        # codegen + library 配置
├── src/main/java/com/wenft/contract/
│   ├── WeNFTFactory.java               # 生成产物（gitignore）
│   ├── WeNFTUpgradeable.java           # 生成产物（gitignore）
│   ├── UpgradeableBeacon.java          # 生成产物（gitignore）
│   └── manager/
│       ├── NftContractProperties.java
│       └── ContractManager.java
├── src/main/resources/application.yml
└── src/test/java/com/wenft/contract/ContractManagerIntegrationTest.java
```

---

## 使用方式：从 Solidity 到 Java 调用

### 0. 前置依赖

- JDK 21
- Node 18+ / pnpm（用于编译 Solidity）
- 可达的目标 RPC 节点（默认 dev 网：`http://139.159.202.235:8545`）

### 1. 编译 Solidity，产出 Hardhat artifacts

在仓库根目录（本模块的父目录）：

```bash
pnpm install         # 仅首次
pnpm compile         # 等价于 hardhat compile
```

产物位于 [../artifacts/contracts/](../artifacts/contracts/)。每个 `.sol` 文件会编译出一份 `XxxContract.json`，里面同时包含 `abi` 和 `bytecode`，这就是 codegen 任务的输入。

### 2. 生成 Java wrapper

```bash
./gradlew generateContractWrappers
```

特性：

- **增量执行**：对每个 artifact 计算 `SHA-256(abi + bytecode)`，与 `build/codegen/abi-hashes/<合约名>.sha256` 比较，未变就跳过。改动单个 `.sol` 时只会重新生成对应 wrapper。
- **输出位置**：`src/main/java/com/wenft/contract/<合约名>.java`
- **包名**：`com.wenft.contract`
- **生成范围**：`../artifacts/contracts/**` 下全部 `.json`（项目自有合约），加上显式引入的 OpenZeppelin `UpgradeableBeacon` artifact（Java 端独立部署 beacon 时需要）。

`./gradlew compileJava` 已经 `dependsOn generateContractWrappers`，编译前会自动跑一次 codegen。

新增合约（例如 `MyToken.sol`）的步骤：先 `pnpm compile`，再 `./gradlew generateContractWrappers`，构建脚本会自动识别新 artifact，无需改任何 build 配置。

### 3. 配置链 + 合约地址

编辑 [src/main/resources/application.yml](src/main/resources/application.yml)（也可以用自己的 yml，通过 `-Dnft.config=/abs/path/foo.yml` 指向）：

```yaml
nft:
  chain:
    rpcUrl: http://139.159.202.235:8545
    privateKey: "0xYOUR_DEPLOYER_KEY"
    chainId: 20200
    gasPrice: 0              # FISCO BCOS 必须为 0
    gasLimit: 30000000       # FISCO BCOS 不支持 estimateGas，需要给一个大的固定值
    receiptPollMillis: 1000
    receiptPollAttempts: 60
  contracts:
    factory: "0x..."         # WeNFTFactory 地址（可选）
    beacon: "0x..."
    implementation: "0x..."
```

`factory` / `beacon` / `implementation` 都是**可选**项：要运行时再部署就留空，要直接绑定已有合约就填上。

### 4. 应用层代码

#### 4.1 初始化

```java
import com.wenft.contract.*;
import com.wenft.contract.manager.*;

NftContractProperties props =
        NftContractProperties.loadYamlFromClasspath("application.yml");
ContractManager mgr = new ContractManager(props);
```

`ContractManager` 内部会装配好 `Web3j`、`Credentials`、`StaticGasProvider`、`RawTransactionManager`（带配置的 chainId）以及 `PollingTransactionReceiptProcessor`，应用代码不需要直接和这些原始类打交道。

#### 4.2 三种常见场景

**场景 A —— 调用已部署的 factory**（最常见）：

```java
WeNFTFactory factory = mgr.weNFTFactory();             // 使用 props.contracts.factory
// 或显式指定：mgr.weNFTFactory("0x...");

BigInteger count  = factory.collectionCount().send();  // 只读
String beaconAddr = factory.beacon().send();           // 只读

// 写交易：自动签名、广播、等回执
TransactionReceipt r = factory
        .createCollection("WHB", "WHB", mgr.credentials().getAddress())
        .send();

String collectionAddr =
        WeNFTFactory.getCollectionCreatedEvents(r).get(0).collection;
```

**场景 B —— 从零部署整套**（每个环境通常只跑一次）：

```java
String admin = mgr.credentials().getAddress();
WeNFTUpgradeable impl  = mgr.deployImplementation();
UpgradeableBeacon bcon = mgr.deployBeacon(impl.getContractAddress(), admin);
WeNFTFactory factory   = mgr.deployFactory(bcon.getContractAddress(), admin);
// 把 impl / bcon / factory 地址回写到 application.yml 或配置中心
```

**场景 C —— 在 collection clone 上 mint**：

```java
WeNFTUpgradeable collection = mgr.weNFT(collectionAddr);

byte[] hash = org.web3j.crypto.Hash.sha3(
        "payload".getBytes(StandardCharsets.UTF_8));
TransactionReceipt mintR = collection
        .mint(toAddr, "ipfs://...", hash, "honor", "Top of Q1", /*soulbound=*/true)
        .send();

BigInteger tokenId = WeNFTUpgradeable.getMintedEvents(mintR).get(0).tokenId;
String uri         = collection.tokenURI(tokenId).send();
```

#### 4.3 关闭

```java
mgr.shutdown();   // 释放底层 HTTP 连接，长进程通常不需要主动调用
```

### 5. 接入 Spring Boot

`ContractManager` 是普通 POJO，Spring 应用只需要声明两个 Bean：

```java
@Configuration
public class NftConfig {
    @Bean
    public NftContractProperties nftContractProperties() {
        return NftContractProperties.loadYamlFromClasspath("application.yml");
    }
    @Bean(destroyMethod = "shutdown")
    public ContractManager contractManager(NftContractProperties props) {
        return new ContractManager(props);
    }
}
```

之后任何 Service 直接注入 `ContractManager` 使用即可。如果想用 Spring 原生的配置绑定（`@ConfigurationProperties(prefix = "nft")`），把 `NftContractProperties` 拷贝到服务侧加上注解即可——本模块本身不依赖 Spring。

### 6. 集成测试 / 冒烟验证

```bash
./gradlew test                                   # 使用 src/test/resources/application-test.yml
./gradlew test -Dnft.config=/abs/path/foo.yml    # 指向 potos testnet 等其他网络
```

[ContractManagerIntegrationTest](src/test/java/com/wenft/contract/ContractManagerIntegrationTest.java) 覆盖了：解析 chainId → 部署整套合约 → createCollection → mint + view 方法校验。接入新链或新增合约时可作为回归基线。

### 7. 常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `eth_estimateGas` 返回 "not supported" | FISCO BCOS 不支持该方法 | 配置 `gasPrice: 0` + 大值 `gasLimit`，不要用 `DefaultGasProvider` |
| `insufficient funds` 报错 | ethers/web3j 客户端做了余额预检 | `gasPrice: 0` 即可绕过 |
| 长进程出现 `nonce too low` | `RawTransactionManager` 本地 nonce 缓存与节点失步 | 重启进程，或改用 `FastRawTransactionManager` 并通过 `mgr.getNextNonce()` 自管 nonce |
| 回执长时间拿不到 | 节点慢或拥堵 | 调大 `receiptPollAttempts` |
| Wrapper 没更新 | ABI+bytecode 哈希未变 | 先 `pnpm compile`，artifact 真正变化后 codegen 才会重新生成 |
| 出现 `Duplicate field(s) found: [FUNC_SAFETRANSFERFROM]` 警告 | `safeTransferFrom` 多个重载在大写化后字段名冲突 | web3j codegen 的已知现象，不影响功能 |

---

## 备注

- 生成的 wrapper 已加入 gitignore——它们是 codegen 的构建产物，不进版本库。
- 本模块**有意不引入 Spring Boot 依赖**，方便被普通 JVM 应用直接使用；接入 Spring 只需要 6 行 `@Bean` 声明（见第 5 节）。
