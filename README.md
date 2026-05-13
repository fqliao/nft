# WeNFT (FISCO BCOS 3.x)

Generic NFT collection template for the **We lottery platform**. Each
collection is an independent ERC721 (own name/symbol/admin/rules) for
any business line — corporate honor badges, mystery boxes, third-party
platform NFTs, etc. Targets FISCO BCOS 3.x (EVM-compatible) and is
fully testable on Hardhat's in-process network.

Collections are minted via a **beacon-proxy factory**: deploy the
implementation + beacon + factory once, then every new collection is one
`createCollection` call (~90k gas per clone). All clones share the same
beacon-driven implementation and **upgrade together** when the beacon
owner calls `upgradeTo`.

## Architecture

```
        ┌──────────────────────┐
        │  UpgradeableBeacon   │  ←─ owner (timelock/multisig in prod)
        │   implementation     │     calls upgradeTo(newImpl)
        └─────────┬────────────┘
                  │  IBeacon.implementation()
        ┌─────────┼─────────┬─────────┐
        │         │         │         │
        ▼         ▼         ▼         ▼
   BeaconProxy ... BeaconProxy   (each clone DELEGATECALLs the impl
   collection-1    collection-N   the beacon currently points at)
        ▲                 ▲
        │  createCollection / createCollectionDeterministic
        │
   ┌────┴────────┐
   │ WeNFTFactory│  ← AccessControl: DEFAULT_ADMIN_ROLE / CREATOR_ROLE
   └─────────────┘
```

The factory and the beacon are independent: the **beacon owner** holds
upgrade authority over every collection, while the **factory admin**
controls who is allowed to create new collections (`CREATOR_ROLE`).

## Capabilities

- ERC721 + Enumerable + URIStorage + Pausable + Burnable + AccessControl
- Roles: `DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`, `PAUSER_ROLE`
- Single `mint` and `batchMint`, each token carrying metadata
  (`category`, `reason`, `issuer`, `issuedAt`, `contentHash`,
  `schemaVersion`, `soulbound`)
- **On-chain authenticity anchoring** via `contentHash` (keccak256 of
  canonicalized off-chain metadata bytes) plus a `verifyContent` view
- **Per-token soulbound flag**: same contract serves both transferable
  collectibles and non-transferable honor tokens
- Admin URI/hash repair (`updateTokenURI`) with full audit trail
  (ERC-4906 `MetadataUpdate` + custom `NFTMetadataUpdated`)
- Schema version snapshots per token (`schemaVersion`) so off-chain
  decoders know which schema to apply
- Queries: `ownerOf`, `balanceOf`, `tokenURI`, `totalSupply`, `getNFTInfo`,
  `tokensOf`, `exists`, `isSoulbound`, `nextTokenId`
- Emergency `pause` / `unpause`
- Deterministic clone deployment via `createCollectionDeterministic`
  (CREATE2): the predicted address depends **only** on `(factory, salt)`,
  not on per-collection name/symbol/admin. The factory deploys an empty
  BeaconProxy via CREATE2 and initializes it atomically in the same tx.
- **Beacon-driven upgradeability**: one `beacon.upgradeTo(newImpl)` call
  migrates every existing collection in lockstep; storage on each clone
  is preserved.

## Project layout

```
contracts/
  WeNFTUpgradeable.sol            # cloneable per-collection implementation
  WeNFTFactory.sol                # beacon-proxy factory
test/
  WeNFTFactory.test.js            # unit tests on hardhat network
  fiscobcos/
    WeNFTFactory.fiscobcos.test.js  # integration tests on a live fisco bcos node
scripts/
  deploy.js                       # deploys impl + beacon + factory
  interact.js                     # end-to-end smoke run incl. beacon upgrade
  extract-artifacts.js            # exports ABIs/bytecode for fisco bcos console
hardhat.config.js                 # solidity 0.8.22, EVM "paris"
```

## Quick start

```bash
pnpm install        # or npm install
npx hardhat compile
npx hardhat test
```

Optional coverage:

```bash
npx hardhat coverage
```

## Deploy to a local Hardhat node

```bash
npx hardhat node                       # terminal A
pnpm deploy:local                      # terminal B
```

After the factory is up, every new collection is one transaction:

```js
const factory = await ethers.getContractAt("WeNFTFactory", FACTORY_ADDR);
const tx = await factory.createCollection("Mystery Box", "MBOX", adminAddr);
// the resulting collection address is in the CollectionCreated event
```

## Deploy to FISCO BCOS 3.x

FISCO BCOS 3.x is EVM-compatible; you can drive it through its
JSON-RPC compatible endpoint. Set the following env vars before
running `pnpm deploy:fiscobcos`:

```
FISCOBCOS_RPC_URL=http://<node>:<port>
FISCOBCOS_CHAIN_ID=20200           # adjust to your chain id
FISCOBCOS_PRIVATE_KEY=0x...         # account that will deploy
```

Optional deploy parameters (consumed by `scripts/deploy.js`):

```
BEACON_OWNER=0x...                 # upgrade authority; defaults to deployer
FACTORY_ADMIN=0x...                # create authority; defaults to deployer
```

> In production, set `BEACON_OWNER` to a timelock or multisig contract
> address rather than an EOA: anyone holding the beacon owner key can
> swap the implementation under every existing collection.

Run integration tests against a live FISCO BCOS node (single signer,
shared deployment, positive paths only):

```bash
pnpm test:fiscobcos
```

> Tip: in production FISCO BCOS deployments you may prefer the official
> `fisco-bcos-sdk` (Java/Go/Node) or the `console` tool. The Hardhat
> profile here is provided for convenience and parity with the unit
> tests; it works against any EVM-compatible RPC FISCO BCOS exposes.

## Upgrading the implementation

When you need to ship a new version of `WeNFTUpgradeable` (bug fix,
feature, etc.):

1. Deploy the new implementation contract: any address with state
   compatible to the previous version's storage layout. Use the
   OpenZeppelin Upgrades plugin (or a manual review) to confirm the
   storage layout has not shifted incompatibly.
2. Have the beacon owner call:

   ```js
   const beacon = await ethers.getContractAt(
     "UpgradeableBeacon",
     BEACON_ADDR
   );
   await beacon.upgradeTo(NEW_IMPL_ADDR);
   ```
3. Every existing `BeaconProxy` collection now DELEGATECALLs the new
   implementation on its very next call. Storage on each collection is
   untouched; only the logic changes.

Verify with `factory.implementation()` (forwards to the beacon) or
`beacon.implementation()`.

## On-chain authenticity model

Each NFT is anchored to a `contentHash = keccak256(raw)` where `raw` is
the canonicalized byte sequence of the off-chain metadata (JCS-normalized
JSON, IPFS DAG block, or any agreed encoding). Anyone holding `raw` can:

```js
// Local verification
const localHash = ethers.keccak256(rawBytes);
expect(localHash).to.equal((await coll.getNFTInfo(tokenId)).contentHash);

// Or have a node compute it for you
const ok = await coll.verifyContent(tokenId, rawBytes);
```

If admin repairs the URI/hash via `updateTokenURI`, both old and new
hashes are emitted on-chain via the `NFTMetadataUpdated` event so
auditors can fully reconstruct history.

## Notes on FISCO BCOS 3.x compatibility

- Solidity 0.8.22 with `evmVersion: paris` is used. 0.8.22 is the
  minimum needed because OpenZeppelin 5.1.0's `ERC1967Utils.sol`
  (transitively required by `BeaconProxy`) requires `^0.8.21`, and
  solc 0.8.21 itself has an internal Natspec bug that crashes
  compilation when contract docs are present. The Paris EVM target
  keeps the bytecode free of Cancun-only opcodes
  (`TLOAD` / `TSTORE` / `MCOPY`) that FISCO BCOS 3.x runtimes do not
  yet support.
- `@openzeppelin/contracts` is pinned to 5.1.0; 5.4+ introduced inline
  `mcopy` in `Bytes.sol` and would not compile against `paris`.
- The contracts rely only on standard EVM features available in FISCO
  BCOS 3.x (no `selfdestruct`, no native value transfer, no pairing
  precompiles, no `BLOCKHASH` dependency).
- `block.timestamp` and `msg.sender` semantics match Ethereum.
