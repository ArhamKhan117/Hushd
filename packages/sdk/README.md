# @hushd/sdk

The Hushd SDK for NEAR: private balances in the Hushd pool, private sends and cash-outs, proofs of one fact for one named reader, private x402 payments, and trading OTC packages on the Hushd desk.

```ts
import { PrivateWallet, TESTNET, identityFromSeed } from "@hushd/sdk";
import { cachedArtifacts, EncryptedFileStore } from "@hushd/sdk/node";
```

- `PrivateWallet`: notes, balances, `send`, `cashOut`, payment requests, and the deal records of a trader or maker.
- Claim links: `payAsLink` pays anyone as a link, `checkLink` and `claimLink` claim it into the claimer's own wallet through the relayer (no gas), `sentLinks` and `takeBackLink` follow up on the links a wallet paid.
- Desk: `packageRequest`, `openRfq`, `awaitMatch`, `checkMatchedTerms`, `settleAsTrader`, `settleAsMaker`. Each deal pays the trader at a one-time address (`dealIdentityFor`); the wallet moves that note into its balance (`moveDealNote`, retried on every sync). `openRfq` skips makers that let more than 25% of their recent deals lapse; `readMakerRecords` counts each maker's record from the desk's deals.
- Proofs: `proveReceipt`, `proveFunds`, `proveVolume`, `verifyProof`, checked again on chain by `pool.verify_disclosure`.
- Agents: `x402Fetch` pays a `hushd` x402 resource from the private balance.
- Intake: `intake` drafts a package from plain words through a NEAR AI Cloud model in a TEE, encrypted to the model's attested key.
- Market: `MarketApi` reads the Hyperliquid mainnet prices the makers price from, through the Hushd API; `crossRate` and `hourStats` give a cross rate and the last hour's change, range and realized volatility.

The contracts live on NEAR testnet (`pool.hushd.testnet`, `desk.hushd.testnet`, `board.hushd.testnet`).
Docs: https://hushd.net/docs/sdk. Source: https://github.com/ArhamKhan117/Hushd.
