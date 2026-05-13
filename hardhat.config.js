require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Drop corporate proxy env vars when deploying to a FISCO BCOS network reachable
// directly. Hardhat's HttpProvider builds a ProxyAgent whenever HTTP_PROXY is
// defined (even as an empty string), and the corporate proxy itself blocks
// Hardhat's outbound telemetry/extension calls, crashing the run.
if (process.argv.some((a) => a === "fiscobcos")) {
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

// Swallow background HTTP errors from Hardhat's telemetry / phone-home that
// fail on locked-down corporate networks. Without this, an undici SocketError
// to an unrelated endpoint crashes the entire deploy before any real work runs.
process.on("unhandledRejection", (err) => {
  if (err && err.code === "UND_ERR_SOCKET") return;
  throw err;
});

/**
 * FISCO BCOS 3.x is EVM-compatible. We use Hardhat's in-process network for
 * unit tests; the `fiscobcos` profile is a placeholder for an actual on-chain
 * deployment via the JSON-RPC compatible endpoint.
 *
 * Network secrets (RPC URL, chain ID, private key) are loaded from .env,
 * which is gitignored. See .env.example for the expected variables.
 *
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    // 0.8.20 + Paris EVM keeps the bytecode free of Cancun-only opcodes
    // (TLOAD/TSTORE/MCOPY), which FISCO BCOS 3.x runtimes do not yet
    // support. @openzeppelin/contracts is pinned to 5.1.0 in package.json
    // for the same reason: 5.4+ introduced inline mcopy in Bytes.sol.
    version: "0.8.20",
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
    fiscobcos: {
      url: process.env.FISCOBCOS_RPC_URL || "http://127.0.0.1:8545",
      chainId: Number(process.env.FISCOBCOS_CHAIN_ID || 20200),
      accounts: process.env.FISCOBCOS_PRIVATE_KEY
        ? [process.env.FISCOBCOS_PRIVATE_KEY]
        : [],
      // FISCO BCOS has no native token; eth_getBalance always returns 0.
      // Pinning gasPrice to 0 and providing an explicit gas limit bypasses
      // ethers' client-side balance precheck (which would otherwise raise
      // InsufficientFunds) and avoids relying on eth_estimateGas.
      gasPrice: 0,
      gas: 30000000,
    },
  },
  mocha: {
    timeout: 60000,
  },
};
