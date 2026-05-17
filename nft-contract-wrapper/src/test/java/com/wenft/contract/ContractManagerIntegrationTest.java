package com.wenft.contract;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.wenft.contract.WeNFTFactory.CollectionCreatedEventResponse;
import com.wenft.contract.WeNFTUpgradeable.MintedEventResponse;
import com.wenft.contract.manager.ContractManager;
import com.wenft.contract.manager.NftContractProperties;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.web3j.crypto.Hash;
import org.web3j.protocol.core.methods.response.TransactionReceipt;

/**
 * End-to-end smoke test. Deploys the entire beacon-proxy stack from Java via
 * the generated wrappers and exercises {@code createCollection} + {@code mint}
 * against the configured FISCO BCOS / EVM network.
 *
 * <p>Run with:
 *
 * <pre>
 *   ./gradlew test                            # uses src/test/resources/application-test.yml
 *   ./gradlew test -Dnft.config=/path/file.yml
 * </pre>
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class ContractManagerIntegrationTest {

    private ContractManager manager;
    private String implAddr;
    private String beaconAddr;
    private String factoryAddr;
    private String collectionAddr;

    @BeforeAll
    void setup() {
        String overridePath = System.getProperty("nft.config", "");
        NftContractProperties props = overridePath.isBlank()
                ? NftContractProperties.loadYamlFromClasspath("application-test.yml")
                : NftContractProperties.loadYaml(overridePath);
        this.manager = new ContractManager(props);
        System.out.println("=== Network ===");
        System.out.println("  RPC      : " + props.getChain().getRpcUrl());
        System.out.println("  Chain ID : " + props.getChain().getChainId());
        System.out.println("  Deployer : " + manager.credentials().getAddress());
    }

    @AfterAll
    void teardown() {
        if (manager != null) manager.shutdown();
    }

    @Test
    @Order(1)
    void resolvesChainIdFromRpc() throws Exception {
        BigInteger chainId = manager.getChainId();
        System.out.println("chainId reported by node = " + chainId);
        assertNotNull(chainId);
        // Allow any chain id (dev/test profiles vary), just assert it's positive.
        assertTrue(chainId.signum() > 0);
    }

    @Test
    @Order(2)
    void deploysBeaconProxyStack() throws Exception {
        WeNFTUpgradeable impl = manager.deployImplementation();
        implAddr = impl.getContractAddress();
        assertNotNull(implAddr);

        UpgradeableBeacon beacon =
                manager.deployBeacon(implAddr, manager.credentials().getAddress());
        beaconAddr = beacon.getContractAddress();
        assertNotNull(beaconAddr);

        String reportedImpl = beacon.implementation().send();
        assertEquals(implAddr.toLowerCase(), reportedImpl.toLowerCase());

        WeNFTFactory factory =
                manager.deployFactory(beaconAddr, manager.credentials().getAddress());
        factoryAddr = factory.getContractAddress();
        assertNotNull(factoryAddr);

        String factoryBeacon = factory.beacon().send();
        assertEquals(beaconAddr.toLowerCase(), factoryBeacon.toLowerCase());

        BigInteger count = factory.collectionCount().send();
        assertEquals(BigInteger.ZERO, count, "fresh factory should have zero collections");
    }

    @Test
    @Order(3)
    void createsCollectionAndDecodesEvent() throws Exception {
        WeNFTFactory factory = manager.weNFTFactory(factoryAddr);
        String admin = manager.credentials().getAddress();

        TransactionReceipt receipt =
                factory.createCollection("We Honor Badge", "WHB", admin).send();
        assertTrue(receipt.isStatusOK(), "createCollection tx must succeed");

        List<CollectionCreatedEventResponse> events =
                WeNFTFactory.getCollectionCreatedEvents(receipt);
        assertEquals(1, events.size(), "exactly one CollectionCreated expected");
        CollectionCreatedEventResponse ev = events.get(0);

        collectionAddr = ev.collection;
        assertNotNull(collectionAddr);
        assertEquals("We Honor Badge", ev.name);
        assertEquals("WHB", ev.symbol);
        assertEquals(admin.toLowerCase(), ev.admin.toLowerCase());
        assertEquals(admin.toLowerCase(), ev.creator.toLowerCase());

        // Cross-check factory state.
        assertEquals(BigInteger.ONE, factory.collectionCount().send());
        assertEquals(
                collectionAddr.toLowerCase(),
                factory.collectionAt(BigInteger.ZERO).send().toLowerCase());

        // Sanity-check the clone exposes the same name/symbol/admin.
        WeNFTUpgradeable collection = manager.weNFT(collectionAddr);
        assertEquals("We Honor Badge", collection.name().send());
        assertEquals("WHB", collection.symbol().send());
    }

    @Test
    @Order(4)
    void mintsOnTheClone() throws Exception {
        WeNFTUpgradeable collection = manager.weNFT(collectionAddr);
        String to = manager.credentials().getAddress();

        byte[] payload = "{\"schema\":1,\"name\":\"Q1 Star\"}".getBytes(StandardCharsets.UTF_8);
        byte[] contentHash = Hash.sha3(payload);

        TransactionReceipt mintReceipt = collection
                .mint(to, "ipfs://qm.../1", contentHash, "honor", "Top of Q1", true)
                .send();
        assertTrue(mintReceipt.isStatusOK(), "mint tx must succeed");

        List<MintedEventResponse> minted = WeNFTUpgradeable.getMintedEvents(mintReceipt);
        assertEquals(1, minted.size());
        MintedEventResponse m = minted.get(0);
        assertEquals(to.toLowerCase(), m.to.toLowerCase());
        assertNotEquals(BigInteger.ZERO, m.tokenId);
        assertEquals("honor", m.category);
        assertTrue(m.soulbound);

        // Read back on-chain state via view methods.
        assertEquals(BigInteger.ONE, collection.totalSupply().send());
        assertEquals(to.toLowerCase(), collection.ownerOf(m.tokenId).send().toLowerCase());
        assertEquals("ipfs://qm.../1", collection.tokenURI(m.tokenId).send());
        assertTrue(collection.isSoulbound(m.tokenId).send());
    }
}
