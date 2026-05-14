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
 * @notice 可克隆版 NFT 合约：作为 implementation 部署一次，由 WeNFTFactory
 *         以 BeaconProxy 形式按业务线克隆出独立的 ERC721 collection
 *         （各自有自己的 name/symbol/admin/规则）。
 *
 *         之所以叫 Upgradeable，是因为它继承了 OpenZeppelin 的 *Upgradeable
 *         系列合约，采用 `initialize(...)` 而非 constructor 初始化状态 ——
 *         因为代理合约部署时不会执行 implementation 的 constructor。
 *         真正的"可升级"由外层的 UpgradeableBeacon 提供。
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

    // 手工调过 slot 顺序以节省 storage：contentHash 占满 slot 0；
    // issuedAt (8B) + issuer (20B) + schemaVersion (2B) + soulbound (1B)
    // 合计 31B 共享 slot 1；两个 dynamic string 各占自己的指针 slot。
    // 升级时严禁改动这几个字段的顺序/类型，只能在末尾追加新字段。
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

    /// @dev 锁定 implementation 自身，不允许被直接 initialize：
    ///      只有 WeNFTFactory 创建的 BeaconProxy 才能调用 `initialize`。
    ///      否则任何人都可以直接对 implementation 地址调 `initialize`
    ///      "劫持"它。OZ Upgrades plugin 通过下面的 natspec 注解识别这
    ///      种安全的 constructor 写法，不视为升级不安全模式。
    /// @custom:oz-upgrades-unsafe-allow constructor
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

    /* --------------------------- Mint 铸造 --------------------------- */

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

    // 内部 helper。命名为 `_issue` 避免与继承自 ERC721 的 `_mint` 重载冲突，
    // 同时保持调用点的可读性。
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

        // 先把全部元数据写入 storage，再 mint token。
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

        // 这里刻意用 `_mint` 而不是 `_safeMint`：
        //  - 平台用例下发行方（We 抽奖平台）对接收方完全可控（员工 EOA、
        //    内部业务合约白名单），不需要对未知合约做 IERC721Receiver
        //    回调校验。
        //  - 更关键的是 FISCO BCOS 3.x 部分节点在开启 account precompile
        //    的配置下，EOA 的 `code.length` 会返回非零（节点把每个账户
        //    都关联了一段 AccountPrecompiled stub bytecode），导致
        //    OpenZeppelin 的 `_checkOnERC721Received` 误把 EOA 当合约
        //    去调用 `onERC721Received(...)`，调用被路由到
        //    AccountPrecompiled 后撞上 "undefined function 0x150b7a02"
        //    而 revert，导致 mint 在这些节点上完全无法工作。
        //    `_mint` 跳过 receiver 检查，绕开节点 quirk。
        _mint(to, tokenId);

        emit Minted(to, tokenId, msg.sender, category, reason, contentHash, ver, soulbound);
    }

    /* --------------------------- 内容真实性校验 --------------------------- */

    /**
     * @notice 校验给定的链下原始字节是否与 mint 时（或最近一次 admin 修复时）
     *         锚定在链上的 contentHash 匹配。
     * @dev    调用方必须传入与 mint 时一致的"规范化字节序列"（如 JCS 规范化的
     *         JSON、IPFS DAG 块字节等）。合约本身不关心规范化算法，发行方与
     *         校验方需在链下约定一致。
     */
    function verifyContent(uint256 tokenId, bytes calldata raw)
        external
        view
        returns (bool)
    {
        if (_ownerOf(tokenId) == address(0)) revert TokenNotExist(tokenId);
        return keccak256(raw) == _nftInfo[tokenId].contentHash;
    }

    /* --------------------------- 查询 --------------------------- */

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

    /* --------------------------- 管理员操作 --------------------------- */

    /**
     * @notice 修复 token 的 URI/contentHash（例如链下存储迁移后修正引用）。
     *         事件同时携带新旧 contentHash，方便审计完整重建历史。
     */
    function updateTokenURI(uint256 tokenId, string calldata newUri, bytes32 newContentHash)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (_ownerOf(tokenId) == address(0)) revert TokenNotExist(tokenId);
        if (newContentHash == bytes32(0)) revert EmptyContentHash();
        bytes32 oldHash = _nftInfo[tokenId].contentHash;
        _nftInfo[tokenId].contentHash = newContentHash;
        // ERC-4906 的 MetadataUpdate(tokenId) 由 ERC721URIStorage._setTokenURI 自动 emit。
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

    /* --------------------------- 父合约方法覆盖 --------------------------- */

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721Upgradeable, ERC721EnumerableUpgradeable, ERC721PausableUpgradeable)
        returns (address)
    {
        address from = _ownerOf(tokenId);
        // Soulbound 限制只针对"持有人→持有人"的转账：mint (from==0) 和
        // burn (to==0) 始终允许，否则带 soulbound 标志的 token 无法被销毁。
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
