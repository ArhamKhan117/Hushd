# @hushd/sdk

The Hushd SDK for NEAR: a private balance in the Hushd pool, private sends and cash-outs, proofs of one fact for one named reader, private x402 payments, and OTC trades on the Hushd desk.
It runs in the browser and in Node, and every transaction is signed on your side.

Hushd runs on NEAR testnet, with test tokens that have no value.

## Install

Node 22 or newer.

```bash
npm install @hushd/sdk
```

## Quick start (Node)

```ts
import { randomBytes } from "node:crypto";
import { identityFromSeed, loadPoseidon, PrivateWallet, RelayerClient, TESTNET } from "@hushd/sdk";
import { cachedArtifacts, EncryptedFileStore } from "@hushd/sdk/node";

await loadPoseidon();
const seed = randomBytes(32); // keep it safe: it is the wallet
const wallet = new PrivateWallet(TESTNET, identityFromSeed(seed), {
  artifacts: await cachedArtifacts({ cacheDir: ".hushd/circuits" }),
  relayer: new RelayerClient(TESTNET.api),
  store: new EncryptedFileStore(".hushd/notes", seed),
});
await wallet.restore();
await wallet.sync();

console.log(wallet.address); // hushd1…, the address others pay privately
console.log(wallet.balances()); // token id -> amount
```

`cachedArtifacts` downloads the proving files from https://hushd.net/circuits once and keeps them in `cacheDir`.

## What is in it

- `PrivateWallet`: notes and balances, `send`, `cashOut`, payment requests, and the deal records of a trader or maker.
- Claim links: `payAsLink` pays anyone as a link; `checkLink` and `claimLink` claim it into the claimer's own wallet through the relayer, with no gas; `sentLinks` and `takeBackLink` follow up on the links a wallet paid.
- Desk: `packageRequest`, `openRfq`, `awaitMatch`, `checkMatchedTerms`, `settleAsTrader` and `settleAsMaker`.
  Each deal pays the trader at a one-time address (`dealIdentityFor`), and the wallet moves that note into its balance (`moveDealNote`, retried on every sync).
  `openRfq` skips makers that let more than 25% of their recent deals lapse; `readMakerRecords` counts each maker's record from the desk's deals.
- Proofs: `proveReceipt`, `proveFunds`, `proveVolume` and `verifyProof`, each made for one reader and an expiry, and checked again on chain by `pool.verify_disclosure`.
- Agents: `x402Fetch` pays a `hushd` x402 resource from the private balance.
- Intake: `intake` drafts a package from plain words through a NEAR AI Cloud model in a TEE, encrypted to the model's attested key.
- NEAR Intents and custody: NEP-413 intents, 1Click quotes, and OutLayer policy wallets, so an agent never holds a NEAR key.
- Market: `MarketApi` reads the Hyperliquid mainnet prices the makers price from; `crossRate` and `hourStats` give a cross rate and the last hour's change, range and realized volatility.
- Network: `TESTNET` and `MAINNET` configs, with free RPC endpoints that rotate and fall back on rate limits.

The contracts live on NEAR testnet: `pool.hushd.testnet`, `desk.hushd.testnet` and `board.hushd.testnet`.

## Links

- Docs: https://hushd.net/docs/sdk
- App: https://hushd.net
- Source: https://github.com/ArhamKhan117/Hushd (packages/sdk)
- License: MIT
