// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./WeNFTUpgradeable.sol";

/**
 * @title WeNFTFactory
 * @notice ERC-1167 minimal-proxy factory that mints new NFT collections by
 *         cloning a single WeNFTUpgradeable implementation. Each clone is a
 *         fully independent ERC721 collection with its own
 *         name/symbol/admin/pause/minter set.
 *
 *         Gas cost: clone deployment ~45 bytes runtime + ~50k gas, vs ~3M
 *         gas for a full new deployment of the implementation. This makes
 *         it cheap to spin up one collection per business line / partner.
 *
 *         Access model
 *         - DEFAULT_ADMIN_ROLE: manages CREATOR_ROLE membership.
 *         - CREATOR_ROLE:       may invoke create*Collection.
 *
 *         The platform admin grants CREATOR_ROLE to internal services (the
 *         WeNFT admin console, lottery business backend) and to authorized
 *         third-party platforms.
 */
contract WeNFTFactory is AccessControl {
    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");

    address public immutable implementation;
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

    error ZeroImplementation();
    error ZeroAdmin();

    constructor(address implementation_, address admin_) {
        if (implementation_ == address(0)) revert ZeroImplementation();
        if (admin_ == address(0)) revert ZeroAdmin();
        implementation = implementation_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(CREATOR_ROLE, admin_);
    }

    /**
     * @notice Creates a new collection by cloning the implementation.
     * @param name_   ERC721 collection name (e.g. "We Honor Badge")
     * @param symbol_ ERC721 collection symbol (e.g. "WHB")
     * @param admin   Address that receives DEFAULT_ADMIN_ROLE / MINTER_ROLE
     *                / PAUSER_ROLE on the cloned collection.
     */
    function createCollection(
        string calldata name_,
        string calldata symbol_,
        address admin
    ) external onlyRole(CREATOR_ROLE) returns (address collection) {
        collection = Clones.clone(implementation);
        WeNFTUpgradeable(collection).initialize(name_, symbol_, admin);
        _register(collection);
        emit CollectionCreated(msg.sender, collection, admin, name_, symbol_, bytes32(0));
    }

    /**
     * @notice CREATE2 variant: the clone address is fully determined by
     *         (factory address, implementation address, salt). Useful when
     *         the caller needs to pre-commit to a collection address (e.g.
     *         pre-printing physical material that references the contract).
     */
    function createCollectionDeterministic(
        string calldata name_,
        string calldata symbol_,
        address admin,
        bytes32 salt
    ) external onlyRole(CREATOR_ROLE) returns (address collection) {
        collection = Clones.cloneDeterministic(implementation, salt);
        WeNFTUpgradeable(collection).initialize(name_, symbol_, admin);
        _register(collection);
        emit CollectionCreated(msg.sender, collection, admin, name_, symbol_, salt);
    }

    function predictAddress(bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt);
    }

    function _register(address collection) internal {
        uint256 idx = collectionCount;
        collectionAt[idx] = collection;
        unchecked { collectionCount = idx + 1; }
    }
}
