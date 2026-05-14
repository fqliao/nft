// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";
import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
// 仅为让 Hardhat 编译时输出 UpgradeableBeacon 的 artifact 而 import。
// Factory 本身不会实例化 beacon —— beacon 由部署脚本独立部署
// （见 scripts/deploy.js），它的地址通过 constructor 传入。
import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "./WeNFTUpgradeable.sol";

/**
 * @title WeNFTFactory
 * @notice Beacon-proxy 工厂：在共享的 WeNFTUpgradeable implementation 前面
 *         部署 BeaconProxy 来铸造新的 NFT collection。每个 clone 是独立的
 *         ERC721 collection（自己的 name/symbol/admin/pause/minter），但
 *         所有 clone 共享同一个 beacon 指向的 implementation —— 当 beacon
 *         的 owner 调 upgradeTo 时，所有 collection 同步升级。
 *
 *         Gas 成本：BeaconProxy 部署 ~90k gas，相比直接重新部署整个
 *         implementation 的 ~3M gas 便宜得多。比 ERC-1167 minimal-proxy
 *         (~50k gas) 稍贵，但换来"全集合一次升级"的能力，对平台运营值得。
 *
 *         权限模型
 *         - DEFAULT_ADMIN_ROLE：管理 CREATOR_ROLE 的授予/撤销。
 *         - CREATOR_ROLE：       可以调用 create*Collection。
 *
 *         升级权在 beacon（Ownable），不在 factory。生产环境 beacon owner
 *         应该是 timelock 或多签合约，不应是 EOA。
 */
contract WeNFTFactory is AccessControl {
    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");

    /// @notice 所有 clone 从这个 beacon 读取当前的 implementation 地址。
    address public immutable beacon;

    /// @dev 在 constructor 中预计算，让 predictAddress 是 O(1) 操作。
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

        // 用"空 initData"对 BeaconProxy 的 creation code 做哈希：
        // 这样 deterministic 部署的地址只依赖 (factory, salt)，与每条业务线
        // 自带的 name/symbol/admin 无关（这些参数由 createCollectionDeterministic
        // 在 CREATE2 部署后的第二步 initialize 中应用）。
        _proxyBytecodeHash = keccak256(
            abi.encodePacked(
                type(BeaconProxy).creationCode,
                abi.encode(beacon_, bytes(""))
            )
        );
    }

    /**
     * @notice ABI 向后兼容入口：以前调用方从 factory 上读取硬编码的
     *         implementation 地址，现在 forward 到 beacon —— 这样查询
     *         到的总是升级后的当前实现地址。
     */
    function implementation() external view returns (address) {
        return IBeacon(beacon).implementation();
    }

    /**
     * @notice 部署 BeaconProxy 并在同一笔交易内 atomically 完成 initialize，
     *         创建一个全新的 collection。
     * @param name_   ERC721 collection 名称（如 "We Honor Badge"）
     * @param symbol_ ERC721 collection 简称（如 "WHB"）
     * @param admin   新 collection 上获得 DEFAULT_ADMIN_ROLE / MINTER_ROLE
     *                / PAUSER_ROLE 的地址。
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
     * @notice CREATE2 确定性部署变体：clone 地址由 (factory address, salt)
     *         完全确定。适合调用方需要"预先承诺地址"的场景，比如把合约
     *         地址先印在实体物料/二维码上再部署。
     *
     *         一笔交易内分两步完成：
     *           1. 用空 initData 通过 CREATE2 部署 BeaconProxy，确保
     *              部署字节码只依赖 beacon 地址，不掺入 name/symbol/admin。
     *           2. 立即调 initialize(name, symbol, admin) 完成初始化。
     *         两步在同一个外部调用里执行，对外部观察者来说是原子的，
     *         链上永远不会出现"未初始化的 collection"中间状态。
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
