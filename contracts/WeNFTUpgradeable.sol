// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title WeNFTUpgradeable
 * @notice Cloneable variant of WeNFT, designed to be deployed once as an
 *         implementation and then cloned per business line via WeNFTFactory
 *         (ERC-1167 minimal proxy). Every clone is an independent ERC721
 *         collection with its own name/symbol/admin/rules.
 *
 *         Functionally identical to contracts/WeNFT.sol; the only
 *         difference is that state is initialized via `initialize(...)`
 *         instead of a constructor, because minimal proxies do not execute
 *         the implementation's constructor.
 */
contract WeNFTUpgradeable is
    Initializable,
    ERC721Upgradeable,
    ERC721EnumerableUpgradeable,
    ERC721URIStorageUpgradeable,
    ERC721PausableUpgradeable,
    ERC721BurnableUpgradeable,
    AccessControlUpgradeable
{
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // Mirrors contracts/WeNFT.sol — hand-tuned for storage packing.
    struct NFTInfo {
        bytes32 contentHash;
        uint64 issuedAt;
        address issuer;
        uint16 schemaVersion;
        bool soulbound;
        string category;
        string reason;
    }

    uint256 private _nextTokenId;
    uint16 public currentSchemaVersion;
    mapping(uint256 => NFTInfo) private _nftInfo;

    event Minted(
        address indexed to,
        uint256 indexed tokenId,
        address indexed issuer,
        string category,
        string reason,
        bytes32 contentHash,
        uint16 schemaVersion,
        bool soulbound
    );
    event NFTMetadataUpdated(
        uint256 indexed tokenId,
        bytes32 oldContentHash,
        bytes32 newContentHash
    );
    event SchemaVersionUpdated(uint16 version);

    error InvalidAdmin();
    error EmptyRecipients();
    error LengthMismatch();
    error TokenNotExist(uint256 tokenId);
    error EmptyContentHash();
    error SoulboundToken(uint256 tokenId);
    error InvalidSchemaVersion();

    /// @dev Locks the implementation contract from being initialized
    ///      directly. Only clones produced by WeNFTFactory may call
    ///      `initialize`. Without this, anyone could call `initialize`
    ///      on the implementation address itself and "hijack" it.
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        address admin
    ) external initializer {
        if (admin == address(0)) revert InvalidAdmin();
        __ERC721_init(name_, symbol_);
        __ERC721Enumerable_init();
        __ERC721URIStorage_init();
        __ERC721Pausable_init();
        __ERC721Burnable_init();
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        currentSchemaVersion = 1;
        _nextTokenId = 1;
    }

    /* --------------------------- Mint --------------------------- */

    function mint(
        address to,
        string calldata uri,
        bytes32 contentHash,
        string calldata category,
        string calldata reason,
        bool soulbound
    ) external onlyRole(MINTER_ROLE) returns (uint256) {
        return _issue(to, uri, contentHash, category, reason, soulbound);
    }

    function batchMint(
        address[] calldata recipients,
        string[] calldata uris,
        bytes32[] calldata contentHashes,
        string calldata category,
        string calldata reason,
        bool soulbound
    ) external onlyRole(MINTER_ROLE) returns (uint256[] memory tokenIds) {
        uint256 n = recipients.length;
        if (n == 0) revert EmptyRecipients();
        if (uris.length != n || contentHashes.length != n) revert LengthMismatch();
        tokenIds = new uint256[](n);
        for (uint256 i = 0; i < n; ) {
            tokenIds[i] = _issue(
                recipients[i],
                uris[i],
                contentHashes[i],
                category,
                reason,
                soulbound
            );
            unchecked { ++i; }
        }
    }

    function _issue(
        address to,
        string calldata uri,
        bytes32 contentHash,
        string calldata category,
        string calldata reason,
        bool soulbound
    ) internal returns (uint256 tokenId) {
        if (contentHash == bytes32(0)) revert EmptyContentHash();
        tokenId = _nextTokenId++;
        uint16 ver = currentSchemaVersion;

        _nftInfo[tokenId] = NFTInfo({
            contentHash: contentHash,
            issuedAt: uint64(block.timestamp),
            issuer: msg.sender,
            schemaVersion: ver,
            soulbound: soulbound,
            category: category,
            reason: reason
        });
        _setTokenURI(tokenId, uri);

        _safeMint(to, tokenId);

        emit Minted(to, tokenId, msg.sender, category, reason, contentHash, ver, soulbound);
    }

    /* --------------------------- Verify --------------------------- */

    function verifyContent(uint256 tokenId, bytes calldata raw)
        external
        view
        returns (bool)
    {
        if (_ownerOf(tokenId) == address(0)) revert TokenNotExist(tokenId);
        return keccak256(raw) == _nftInfo[tokenId].contentHash;
    }

    /* --------------------------- Query --------------------------- */

    function getNFTInfo(uint256 tokenId) external view returns (NFTInfo memory) {
        if (_ownerOf(tokenId) == address(0)) revert TokenNotExist(tokenId);
        return _nftInfo[tokenId];
    }

    function tokensOf(address owner) external view returns (uint256[] memory ids) {
        uint256 bal = balanceOf(owner);
        ids = new uint256[](bal);
        for (uint256 i = 0; i < bal; ) {
            ids[i] = tokenOfOwnerByIndex(owner, i);
            unchecked { ++i; }
        }
    }

    function exists(uint256 tokenId) external view returns (bool) {
        return _ownerOf(tokenId) != address(0);
    }

    function isSoulbound(uint256 tokenId) external view returns (bool) {
        if (_ownerOf(tokenId) == address(0)) revert TokenNotExist(tokenId);
        return _nftInfo[tokenId].soulbound;
    }

    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    /* --------------------------- Admin --------------------------- */

    function updateTokenURI(uint256 tokenId, string calldata newUri, bytes32 newContentHash)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (_ownerOf(tokenId) == address(0)) revert TokenNotExist(tokenId);
        if (newContentHash == bytes32(0)) revert EmptyContentHash();
        bytes32 oldHash = _nftInfo[tokenId].contentHash;
        _nftInfo[tokenId].contentHash = newContentHash;
        _setTokenURI(tokenId, newUri);
        emit NFTMetadataUpdated(tokenId, oldHash, newContentHash);
    }

    function setSchemaVersion(uint16 v) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (v == 0) revert InvalidSchemaVersion();
        currentSchemaVersion = v;
        emit SchemaVersionUpdated(v);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /* --------------------------- Overrides --------------------------- */

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721Upgradeable, ERC721EnumerableUpgradeable, ERC721PausableUpgradeable)
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && _nftInfo[tokenId].soulbound) {
            revert SoulboundToken(tokenId);
        }
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value)
        internal
        override(ERC721Upgradeable, ERC721EnumerableUpgradeable)
    {
        super._increaseBalance(account, value);
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721Upgradeable, ERC721URIStorageUpgradeable)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(
            ERC721Upgradeable,
            ERC721EnumerableUpgradeable,
            ERC721URIStorageUpgradeable,
            AccessControlUpgradeable
        )
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
