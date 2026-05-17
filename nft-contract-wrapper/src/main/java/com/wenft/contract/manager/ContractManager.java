package com.wenft.contract.manager;

import com.wenft.contract.UpgradeableBeacon;
import com.wenft.contract.WeNFTFactory;
import com.wenft.contract.WeNFTUpgradeable;
import java.io.IOException;
import java.math.BigInteger;
import lombok.extern.slf4j.Slf4j;
import org.web3j.crypto.Credentials;
import org.web3j.protocol.Web3j;
import org.web3j.protocol.core.DefaultBlockParameterName;
import org.web3j.protocol.core.methods.response.EthChainId;
import org.web3j.protocol.core.methods.response.EthGetTransactionCount;
import org.web3j.protocol.http.HttpService;
import org.web3j.tx.RawTransactionManager;
import org.web3j.tx.TransactionManager;
import org.web3j.tx.gas.ContractGasProvider;
import org.web3j.tx.gas.DefaultGasProvider;
import org.web3j.tx.gas.StaticGasProvider;
import org.web3j.tx.response.PollingTransactionReceiptProcessor;

/**
 * Thin façade around the Web3j-generated WeNFT contract wrappers.
 *
 * <p>Construct it from {@link NftContractProperties} (loaded however you like
 * - YAML, env, Spring config, etc.). It exposes:
 *
 * <ul>
 *   <li>{@code load*()} methods that bind a wrapper to an already-deployed address,
 *   <li>{@code deploy*()} helpers for first-time provisioning,
 *   <li>direct accessors for the underlying {@link Web3j}, {@link Credentials},
 *       {@link ContractGasProvider} and {@link TransactionManager}.
 * </ul>
 *
 * <p>FISCO BCOS note: the dev/test networks expose an eth-compatible JSON-RPC but
 * reject {@code eth_estimateGas}. Configure {@code gasPrice=0} and a fat
 * {@code gasLimit} (e.g. 30_000_000) to bypass the estimator.
 */
@Slf4j
public class ContractManager {

    private final NftContractProperties properties;
    private final Web3j web3j;
    private final Credentials credentials;
    private final ContractGasProvider gasProvider;
    private final TransactionManager transactionManager;
    private volatile BigInteger resolvedChainId;

    public ContractManager(NftContractProperties properties) {
        this.properties = properties;

        NftContractProperties.Chain chain = properties.getChain();
        if (chain.getRpcUrl() == null || chain.getRpcUrl().isBlank()) {
            throw new IllegalStateException("nft.chain.rpcUrl must be configured");
        }
        if (chain.getPrivateKey() == null || chain.getPrivateKey().isBlank()) {
            throw new IllegalStateException("nft.chain.privateKey must be configured");
        }

        this.web3j = Web3j.build(new HttpService(chain.getRpcUrl()));
        this.credentials = Credentials.create(chain.getPrivateKey());

        if (chain.getGasPrice() != null && chain.getGasLimit() != null) {
            this.gasProvider = new StaticGasProvider(chain.getGasPrice(), chain.getGasLimit());
        } else {
            this.gasProvider = new DefaultGasProvider();
        }

        long pollMillis = chain.getReceiptPollMillis() > 0 ? chain.getReceiptPollMillis() : 1000L;
        int pollAttempts =
                chain.getReceiptPollAttempts() > 0 ? chain.getReceiptPollAttempts() : 60;
        PollingTransactionReceiptProcessor receiptProcessor =
                new PollingTransactionReceiptProcessor(web3j, pollMillis, pollAttempts);

        long chainIdHint = chain.getChainId() != null ? chain.getChainId() : -1L;
        this.transactionManager =
                new RawTransactionManager(web3j, credentials, chainIdHint, receiptProcessor);

        log.info(
                "ContractManager initialized: rpc={} chainId={} deployer={}",
                chain.getRpcUrl(),
                chainIdHint,
                credentials.getAddress());
    }

    // ---- Wrapper bindings ------------------------------------------------

    public WeNFTFactory weNFTFactory() {
        String address = required(properties.getContracts().getFactory(), "nft.contracts.factory");
        return weNFTFactory(address);
    }

    public WeNFTFactory weNFTFactory(String address) {
        return WeNFTFactory.load(address, web3j, transactionManager, gasProvider);
    }

    public WeNFTUpgradeable weNFT(String address) {
        return WeNFTUpgradeable.load(address, web3j, transactionManager, gasProvider);
    }

    public UpgradeableBeacon beacon() {
        String address = required(properties.getContracts().getBeacon(), "nft.contracts.beacon");
        return beacon(address);
    }

    public UpgradeableBeacon beacon(String address) {
        return UpgradeableBeacon.load(address, web3j, transactionManager, gasProvider);
    }

    // ---- Deployment helpers ----------------------------------------------

    /** Deploy a fresh {@code WeNFTUpgradeable} implementation. */
    public WeNFTUpgradeable deployImplementation() throws Exception {
        log.info("Deploying WeNFTUpgradeable implementation...");
        WeNFTUpgradeable impl =
                WeNFTUpgradeable.deploy(web3j, transactionManager, gasProvider).send();
        log.info("Implementation deployed @ {}", impl.getContractAddress());
        return impl;
    }

    /** Deploy a fresh {@code UpgradeableBeacon} pointing at the given implementation. */
    public UpgradeableBeacon deployBeacon(String implementation, String owner) throws Exception {
        log.info("Deploying UpgradeableBeacon(impl={}, owner={})", implementation, owner);
        UpgradeableBeacon beacon =
                UpgradeableBeacon.deploy(web3j, transactionManager, gasProvider, implementation, owner)
                        .send();
        log.info("Beacon deployed @ {}", beacon.getContractAddress());
        return beacon;
    }

    /** Deploy a fresh {@code WeNFTFactory} pointing at the given beacon. */
    public WeNFTFactory deployFactory(String beacon, String admin) throws Exception {
        log.info("Deploying WeNFTFactory(beacon={}, admin={})", beacon, admin);
        WeNFTFactory factory =
                WeNFTFactory.deploy(web3j, transactionManager, gasProvider, beacon, admin).send();
        log.info("Factory deployed @ {}", factory.getContractAddress());
        return factory;
    }

    // ---- Accessors -------------------------------------------------------

    public Web3j web3j() {
        return web3j;
    }

    public Credentials credentials() {
        return credentials;
    }

    public ContractGasProvider gasProvider() {
        return gasProvider;
    }

    public TransactionManager transactionManager() {
        return transactionManager;
    }

    public NftContractProperties properties() {
        return properties;
    }

    /** Resolve the chain id from the RPC node (cached). */
    public BigInteger getChainId() throws IOException {
        if (resolvedChainId != null) {
            return resolvedChainId;
        }
        synchronized (this) {
            if (resolvedChainId != null) {
                return resolvedChainId;
            }
            EthChainId ethChainId = web3j.ethChainId().send();
            if (ethChainId.hasError()) {
                throw new IOException("eth_chainId failed: " + ethChainId.getError().getMessage());
            }
            BigInteger id = ethChainId.getChainId();
            if (id == null) {
                throw new IOException("eth_chainId returned no value");
            }
            resolvedChainId = id;
            log.info("Resolved chainId from rpc: {}", id);
            return id;
        }
    }

    /** Next nonce for the configured signer. */
    public BigInteger getNextNonce() throws IOException {
        return getNextNonce(credentials.getAddress());
    }

    /** Next nonce for an arbitrary address. */
    public BigInteger getNextNonce(String address) throws IOException {
        EthGetTransactionCount r =
                web3j.ethGetTransactionCount(address, DefaultBlockParameterName.PENDING).send();
        if (r.hasError()) {
            throw new IOException("eth_getTransactionCount failed: " + r.getError().getMessage());
        }
        return r.getTransactionCount();
    }

    /** Release the underlying HTTP transport. */
    public void shutdown() {
        web3j.shutdown();
    }

    private static String required(String value, String key) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(key + " must be configured");
        }
        return value;
    }
}
