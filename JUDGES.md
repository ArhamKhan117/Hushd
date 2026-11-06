# For judges

A five-minute path through Hushd, then where to look in the code.

## Five minutes

1. Open [hushd.net/app](https://hushd.net/app) and sign in with a passkey (no wallet needed; the relayer opens the account on testnet).
2. Balance, then Add privately: the faucet gives test USDC and one click moves it into the pool.
3. Desk, then Describe it: type "sell 500 USDC for BTC, at least 0.008 BTC". The draft comes from a NEAR AI model in a TEE; the line under the box shows the attestation the API verified, and the draft shows the signature your browser checked.
4. Ask for quotes and watch the steps: committed on chain, sealed quotes arriving, matched in the enclave, settled in the pool. Open the deal page: the chain shows a deal and an outcome, not the amounts or you.
5. Prove, then Exact payment for that deal, reader `judge.testnet`, then open the link. The checker verifies the proof in your browser and asks the pool contract to check it again.

Or, from a terminal, with no keys: `pnpm install && pnpm verify` checks every README claim against the live deployment.

## What to look at

| Claim | Code |
| --- | --- |
| Groth16 verified on chain with `alt_bn128` | `contracts/pool/src/groth16.rs`, `contracts/pool/src/lib.rs` (`transact`, `settle_swap`) |
| Both legs settle or neither | `contracts/pool/src/lib.rs` (`settle_swap`), `contracts/desk/src/lib.rs` (`settle`, `on_settled`) |
| A match must come from the enclave, and each quote carries its maker's consent | `contracts/desk/src/lib.rs` (`on_match`, `submit_match`, `accept_match`), `matcher/src/main.rs` |
| Makers never see the limit | `packages/sdk/src/desk.ts` (`packageRequest`, `openRfq`) |
| The hedge is signed by Chain Signatures per deal; a missed hedge pays the bond to the trader privately | `contracts/desk/src/hedge.rs`, `contracts/desk/src/lib.rs` (`sign_hedge_order`, `slash_overdue`), `services/src/keeper.ts` |
| Proofs for one reader with an expiry | `circuits/receipt/receipt.circom` (`context`), `packages/sdk/src/field.ts` (`proofContext`), `packages/sdk/src/proofs.ts` |
| NEAR AI intake is end-to-end encrypted and verified | `packages/sdk/src/intake.ts`, `services/src/intake.ts` |
| Private x402 | `packages/sdk/src/x402.ts` and its tests, `services/src/makers.ts` |
| Agents spend only inside limits | `packages/mcp/src/limits.ts`, `packages/mcp/test/mcp.test.ts` |
| Bytes agree across TypeScript and both Rust codebases | `packages/protocol/test/protocol.test.ts`, `matcher/tests/interop.json`, `contracts/desk/src/hedge.rs` tests |

## Honest limits

- Testnet only, with test tokens and development proving keys.
- The contracts had an internal review, not an external audit.
- The hedge leg trades on Hyperliquid testnet.
- Deposits and cash outs are public, and timing can link them; the docs say how to reduce that.
