// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";
import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
// Imported only so Hardhat compiles UpgradeableBeacon and emits its artifact.
// The factory itself never instantiates a beacon — the beacon is deployed
// independently (see scripts/deploy.js) and its address is passed in.
import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "./WeNFTUpgradeable.sol";

/**
 * @title WeNFTFactory
 * @notice Beacon-proxy factory that mints new NFT collections by deploying
 *         a BeaconProxy in front of a shared, upgradeable WeNFTUpgradeable
 *         implementation. Every clone is an independent ERC721 collection
 *         with its own name/symbol/admin/pause/minter set, but all clones
 *         share the same beacon-driven implementation and upgrade together
 *         when the beacon owner calls upgradeTo.
 *
 *         Gas cost: BeaconProxy deployment ~90k gas, vs ~3M gas for a full
 *         redeploy of the implementation. Slightly more expensive than an
 *         ERC-1167 minimal-proxy clone (~50k gas) but in return all clones
 *         become upgradeable in lockstep via a single beacon transaction.
 *
 *         Access model
 *         - DEFAULT_ADMIN_ROLE: manages CREATOR_ROLE membership.
 *         - CREATOR_ROLE:       may invoke create*Collection.
 *
 *         Upgrade authority lives on the beacon (Ownable), not on the
 *         factory. In production the beacon owner should be a timelock or
 *         multisig rather than an EOA.
 */
contract WeNFTFactory is AccessControl {
    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");

    /// @notice The beacon all clones read their implementation address from.
    address public immutable beacon;

    /// @dev Precomputed at construction so predictAddress is O(1).
    bytes32 private immutable _proxyBytecodeHash;

    uint256 public collectionCount;
    mapping(uint256 => address) public collectionAt;

    event CollectionCreated(
        address indexed creator,
        address indexed collection,
        address indexed admin,
        string name,
        string symbol,
        bytes32 salt
    );

    error ZeroBeacon();
    error ZeroAdmin();

    constructor(address beacon_, address admin_) {
        if (beacon_ == address(0)) revert ZeroBeacon();
        if (admin_ == address(0)) revert ZeroAdmin();
        beacon = beacon_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(CREATOR_ROLE, admin_);

        // Hash the BeaconProxy creation code with an EMPTY initData so the
        // deterministic-deploy address depends only on (factory, salt) and
        // not on the per-collection name/symbol/admin (those are applied in
        // a second step by createCollectionDeterministic).
        _proxyBytecodeHash = keccak256(
            abi.encodePacked(
                type(BeaconProxy).creationCode,
                abi.encode(beacon_, bytes(""))
            )
        );
    }

    /**
     * @notice ABI-compat alias for callers that previously read the
     *         hard-coded implementation address off the factory. Now this
     *         forwards to the beacon, so the answer reflects the current
     *         live implementation after any upgrade.
     */
    function implementation() external view returns (address) {
        return IBeacon(beacon).implementation();
    }

    /**
     * @notice Creates a new collection by deploying a BeaconProxy and
     *         initializing it atomically in a single transaction.
     * @param name_   ERC721 collection name (e.g. "We Honor Badge")
     * @param symbol_ ERC721 collection symbol (e.g. "WHB")
     * @param admin   Address that receives DEFAULT_ADMIN_ROLE / MINTER_ROLE
     *                / PAUSER_ROLE on the new collection.
     */
    function createCollection(
        string calldata name_,
        string calldata symbol_,
        address admin
    ) external onlyRole(CREATOR_ROLE) returns (address collection) {
        bytes memory initData = abi.encodeCall(
            WeNFTUpgradeable.initialize,
            (name_, symbol_, admin)
        );
        collection = address(new BeaconProxy(beacon, initData));
        _register(collection);
        emit CollectionCreated(msg.sender, collection, admin, name_, symbol_, bytes32(0));
    }

    /**
     * @notice CREATE2 variant: the clone address is fully determined by
     *         (factory address, salt). Useful when the caller needs to
     *         pre-commit to a collection address (e.g. pre-printing physical
     *         material that references the contract).
     *
     *         Implemented as two steps in one transaction:
     *           1. CREATE2 a BeaconProxy with EMPTY initData so the
     *              deployed bytecode depends only on the beacon address.
     *           2. Call initialize(name, symbol, admin) on the new proxy.
     *         Both run in the same external call, so external observers
     *         only ever see an initialized collection.
     */
    function createCollectionDeterministic(
        string calldata name_,
        string calldata symbol_,
        address admin,
        bytes32 salt
    ) external onlyRole(CREATOR_ROLE) returns (address collection) {
        bytes memory bytecode = abi.encodePacked(
            type(BeaconProxy).creationCode,
            abi.encode(beacon, bytes(""))
        );
        collection = Create2.deploy(0, salt, bytecode);
        WeNFTUpgradeable(collection).initialize(name_, symbol_, admin);

        _register(collection);
        emit CollectionCreated(msg.sender, collection, admin, name_, symbol_, salt);
    }

    function predictAddress(bytes32 salt) external view returns (address) {
        return Create2.computeAddress(salt, _proxyBytecodeHash);
    }

    function _register(address collection) internal {
        uint256 idx = collectionCount;
        collectionAt[idx] = collection;
        unchecked { collectionCount = idx + 1; }
    }
}
