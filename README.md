# WeNFT (FISCO BCOS 3.x)

Generic NFT collection template for the **We lottery platform**. Each
collection is an independent ERC721 (own name/symbol/admin/rules) for
any business line — corporate honor badges, mystery boxes, third-party
platform NFTs, etc. Targets FISCO BCOS 3.x (EVM-compatible) and is
fully testable on Hardhat's in-process network.

Collections are minted via an ERC-1167 minimal-proxy factory: deploy
the implementation + factory once, then every new collection is one
`createCollection` call (~50k gas per clone).

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
  (CREATE2) with `predictAddress` for upfront address computation

## Project layout

```
contracts/
  WeNFTUpgradeable.sol            # cloneable per-collection implementation
  WeNFTFactory.sol                # ERC-1167 minimal-proxy factory
test/
  WeNFTFactory.test.js            # unit tests on hardhat network
  fiscobcos/
    WeNFTFactory.fiscobcos.test.js  # integration tests on a live fisco bcos node
scripts/
  deploy.js                       # deploys implementation + factory
  interact.js                     # end-to-end smoke run against a network
hardhat.config.js                 # solidity 0.8.20, EVM "paris"
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

Optional deploy parameter (consumed by `scripts/deploy.js`):

```
FACTORY_ADMIN=0x...                # defaults to deployer
```

Run integration tests against a live FISCO BCOS node (single signer,
shared deployment, positive paths only):

```bash
pnpm test:fiscobcos
```

> Tip: in production FISCO BCOS deployments you may prefer the official
> `fisco-bcos-sdk` (Java/Go/Node) or the `console` tool. The Hardhat
> profile here is provided for convenience and parity with the unit
> tests; it works against any EVM-compatible RPC FISCO BCOS exposes.

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

- Solidity 0.8.20 with `evmVersion: paris` is used to avoid Cancun-only
  opcodes (`TLOAD` / `TSTORE` / `MCOPY`) that FISCO BCOS 3.x runtimes do
  not yet support.
- `@openzeppelin/contracts` is pinned to 5.1.0; 5.4+ introduced inline
  `mcopy` in `Bytes.sol` and would not compile against `paris`.
- The contracts rely only on standard EVM features available in FISCO
  BCOS 3.x (no `selfdestruct`, no native value transfer, no pairing
  precompiles, no `BLOCKHASH` dependency).
- `block.timestamp` and `msg.sender` semantics match Ethereum.
