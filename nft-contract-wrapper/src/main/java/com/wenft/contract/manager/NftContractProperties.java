package com.wenft.contract.manager;

import java.io.IOException;
import java.io.InputStream;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import lombok.Getter;
import lombok.Setter;
import org.yaml.snakeyaml.Yaml;

/**
 * Configuration POJO for the WeNFT on-chain bindings.
 *
 * <p>Mirrors {@code RwaContractProperties} in {@code rwa-contract-wrapper} but
 * intentionally has no Spring dependency: callers either populate the fields
 * programmatically or load a YAML via {@link #loadYaml(String)} /
 * {@link #loadYamlFromClasspath(String)}.
 */
@Getter
@Setter
public class NftContractProperties {

    private Chain chain = new Chain();
    private Contracts contracts = new Contracts();

    @Getter
    @Setter
    public static class Chain {
        private String rpcUrl;
        private String privateKey;
        /** EVM chain id used to sign EIP-155 transactions. */
        private Long chainId;
        /** Static gas price; falls back to {@code DefaultGasProvider} when null. */
        private BigInteger gasPrice;
        /** Static gas limit; falls back to {@code DefaultGasProvider} when null. */
        private BigInteger gasLimit;
        /** Polling interval in millis used by the transaction receipt processor. */
        private long receiptPollMillis = 1000L;
        /** Max number of polling attempts before giving up on a receipt. */
        private int receiptPollAttempts = 60;
    }

    @Getter
    @Setter
    public static class Contracts {
        /** Deployed {@code WeNFTFactory} address. Optional - tests can deploy fresh. */
        private String factory;
        /** Deployed {@code UpgradeableBeacon} address. Optional. */
        private String beacon;
        /** Deployed {@code WeNFTUpgradeable} implementation address. Optional. */
        private String implementation;
    }

    /** Load configuration from a classpath resource (e.g. {@code application.yml}). */
    public static NftContractProperties loadYamlFromClasspath(String resource) {
        try (InputStream in = NftContractProperties.class.getClassLoader()
                .getResourceAsStream(resource)) {
            if (in == null) {
                throw new IllegalArgumentException("Classpath resource not found: " + resource);
            }
            return parseYaml(new Yaml().load(in));
        } catch (IOException e) {
            throw new RuntimeException("Failed to read classpath resource: " + resource, e);
        }
    }

    /** Load configuration from a filesystem path. */
    public static NftContractProperties loadYaml(String path) {
        try (InputStream in = Files.newInputStream(Path.of(path))) {
            return parseYaml(new Yaml().load(in));
        } catch (IOException e) {
            throw new RuntimeException("Failed to read YAML file: " + path, e);
        }
    }

    @SuppressWarnings("unchecked")
    private static NftContractProperties parseYaml(Object root) {
        if (!(root instanceof Map)) {
            throw new IllegalArgumentException("YAML root must be a mapping, got: " + root);
        }
        Map<String, Object> rootMap = (Map<String, Object>) root;
        Map<String, Object> nft = (Map<String, Object>) rootMap.getOrDefault("nft", Map.of());

        NftContractProperties props = new NftContractProperties();

        Map<String, Object> chain = (Map<String, Object>) nft.getOrDefault("chain", Map.of());
        Chain c = props.getChain();
        c.setRpcUrl(asString(chain.get("rpcUrl")));
        c.setPrivateKey(asString(chain.get("privateKey")));
        c.setChainId(asLong(chain.get("chainId")));
        c.setGasPrice(asBigInteger(chain.get("gasPrice")));
        c.setGasLimit(asBigInteger(chain.get("gasLimit")));
        Long pollMs = asLong(chain.get("receiptPollMillis"));
        if (pollMs != null) c.setReceiptPollMillis(pollMs);
        Long pollAttempts = asLong(chain.get("receiptPollAttempts"));
        if (pollAttempts != null) c.setReceiptPollAttempts(pollAttempts.intValue());

        Map<String, Object> contracts =
                (Map<String, Object>) nft.getOrDefault("contracts", Map.of());
        Contracts kontracts = props.getContracts();
        kontracts.setFactory(asString(contracts.get("factory")));
        kontracts.setBeacon(asString(contracts.get("beacon")));
        kontracts.setImplementation(asString(contracts.get("implementation")));

        return props;
    }

    private static String asString(Object o) {
        return o == null ? null : o.toString();
    }

    private static Long asLong(Object o) {
        if (o == null) return null;
        if (o instanceof Number n) return n.longValue();
        return Long.parseLong(o.toString());
    }

    private static BigInteger asBigInteger(Object o) {
        if (o == null) return null;
        if (o instanceof Number n) return BigInteger.valueOf(n.longValue());
        return new BigInteger(o.toString());
    }
}
