# @hushd/sdk

The Hushd SDK for NEAR: private balances in the Hushd pool, private sends and cash-outs, proofs of one fact for one named reader, private x402 payments, and trading OTC packages on the Hushd desk.

```ts
import { PrivateWallet, TESTNET, identityFromSeed } from "@hushd/sdk";
import { cachedArtifacts, EncryptedFileStore } from "@hushd/sdk/node";
```

- `PrivateWallet`: notes, balances, `send`, `cashOut`, payment requests, and the deal records of a trader or maker.
- Desk: `packageRequest`, `openRfq`, `awaitMatch`, `checkMatchedTerms`, `settleAsTrader`, `settleAsMaker`.
- Proofs: `proveReceipt`, `proveFunds`, `proveVolume`, `verifyProof`, checked again on chain by `pool.verify_disclosure`.
- Agents: `x402Fetch` pays a `hushd` x402 resource from the private balance.
- Intake: `intake` drafts a package from plain words through a NEAR AI Cloud model in a TEE, encrypted to the model's attested key.

The contracts live on NEAR testnet (`pool.hushd.testnet`, `desk.hushd.testnet`, `board.hushd.testnet`).
Docs: https://hushd.net/docs/sdk. Source: https://github.com/ArhamKhan117/Hushd.
