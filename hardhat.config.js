require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config();

// 部署到可直连的 FISCO BCOS 节点时，把企业代理相关的环境变量清掉。
// Hardhat 的 HttpProvider 一旦看到 HTTP_PROXY（即使是空字符串）就会构造
// ProxyAgent，而公司代理本身又会拦截 Hardhat 的 telemetry/extension 调用，
// 导致部署还没真开始就挂掉。
// 这里用 includes 而不是精确匹配，能同时覆盖 fiscobcos-dev / fiscobcos-test
// 这两个细分 network 名。
if (process.argv.some((a) => a.includes("fiscobcos"))) {
  for (const k of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    delete process.env[k];
  }
}

// 吃掉 Hardhat 的 telemetry / phone-home 在受限内网下抛出的后台 HTTP 错误。
// 不加这个钩子的话，一个无关 endpoint 的 undici SocketError 会把整个
// deploy 流程 crash 掉。
process.on("unhandledRejection", (err) => {
  if (err && err.code === "UND_ERR_SOCKET") return;
  throw err;
});

// 两套 FISCO BCOS 网络的共享 transport 配置。
//   - FISCO BCOS 没有原生币，eth_getBalance 恒为 0；把 gasPrice 锁为 0
//     可绕过 ethers 客户端侧的余额预检（否则抛 InsufficientFunds）。
//   - `gas: 30000000` 仅作 hardhat provider 直发 tx 的默认 gasLimit，
//     hardhat-ethers v3 的 Signer 不读这个字段。调 BeaconProxy 方法时
//     如果撞上节点 estimateGas 不可用，需要在 tx options 里显式传
//     `{ gasLimit }`。
const FISCOBCOS_BASE = {
  gasPrice: 0,
  gas: 30000000,
};

// 单一 .env 同时承载两套环境配置。运行时通过 `--network fiscobcos-dev`
// 或 `--network fiscobcos-test` 选择其中一组：
//   FISCOBCOS_DEV_RPC_URL      / FISCOBCOS_TEST_RPC_URL
//   FISCOBCOS_DEV_CHAIN_ID     / FISCOBCOS_TEST_CHAIN_ID
//   FISCOBCOS_DEV_PRIVATE_KEY  / FISCOBCOS_TEST_PRIVATE_KEY
function fiscobcosNetwork(envPrefix) {
  return {
    url: process.env[`${envPrefix}_RPC_URL`] || "http://127.0.0.1:8545",
    chainId: Number(process.env[`${envPrefix}_CHAIN_ID`] || 20200),
    accounts: process.env[`${envPrefix}_PRIVATE_KEY`]
      ? [process.env[`${envPrefix}_PRIVATE_KEY`]]
      : [],
    ...FISCOBCOS_BASE,
  };
}

/**
 * FISCO BCOS 3.x 兼容 EVM。单测跑在 Hardhat 内置网络上；
 * `fiscobcos-dev` / `fiscobcos-test` 两个 profile 分别对应开发、测试环境
 * 的真链部署，通过其暴露的 JSON-RPC 兼容端点交互。
 *
 * 网络敏感配置（RPC URL、chain ID、私钥）由 .env 提供（.gitignore 已排除），
 * 期望的环境变量见 .env.example。
 *
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    // 0.8.22 是当前最低可用版本：@openzeppelin/contracts 5.1.0 的
    // ERC1967Utils.sol（被 BeaconProxy 间接依赖）要求 ^0.8.21；而 solc
    // 0.8.21 本身有一个 Natspec 相关的内部 bug，遇到带文档注释的合约会
    // 直接 crash，所以跳到 0.8.22。
    // evmVersion 锁定 "paris" 以避免生成 Cancun-only opcodes
    // (TLOAD/TSTORE/MCOPY)，因为 FISCO BCOS 3.x 运行时还不支持这些。
    // @openzeppelin/contracts 同理锁定在 5.1.0：5.4+ 在 Bytes.sol 中
    // 引入了内联 mcopy，无法在 paris 下编译。
    version: "0.8.22",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {},
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    "fiscobcos-dev": fiscobcosNetwork("FISCOBCOS_DEV"),
    "fiscobcos-test": fiscobcosNetwork("FISCOBCOS_TEST"),
  },
  mocha: {
    timeout: 60000,
  },
};
