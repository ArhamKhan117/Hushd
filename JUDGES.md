# For judges

A five-minute path through Hushd, then where to look in the code.

## Five minutes

1. Open [hushd.net/app](https://hushd.net/app) and sign in with a passkey (no wallet needed; the relayer opens the account on testnet).
2. Balance, then Add privately: the faucet gives test USDC and one click moves it into the pool.
3. Desk, then Describe it: type "sell 500 USDC for BTC at the best price". The draft comes from a NEAR AI model in a TEE; the line under the box shows the attestation the API verified, and the draft shows the signature your browser checked. (Or use Fill the form: Spot, 500 USDC, BTC.)
4. Ask for quotes and watch the steps: committed on chain, sealed quotes arriving, matched in the enclave, settled in the pool. Open the deal page: the chain shows a deal and an outcome, not the amounts or you. Or trade from [Trade](https://hushd.net/app/trade): the same flow beside a live chart, with your deal settling in the panel below.
5. Prove, then Exact payment for that deal, reader `judge.testnet`, then open the link. The checker verifies the proof in your browser and asks the pool contract to check it again.

Already made for you: `deployments/judge-proof-payment.txt` (an exact payment that settled desk deal #2) and `deployments/judge-proof-funds.txt` (a balance of at least 1,000 USDC, from a wallet that only backs it), both for `judge.testnet`, until 6 and 10 December 2026. The pool checks each against its reader and expiry on chain. Paste one into [hushd.net/verify](https://hushd.net/verify) as `judge.testnet`, then as anyone else to see it refused.

Watch an agent do all of it: `pnpm stack` in one terminal, then `pnpm --filter @hushd/services exec tsx scripts/demo-agent.ts`. It drives the MCP server's tools through the agent's policy wallet: a deposit signed in OutLayer's TEE, a call outside its policy refused by the TEE, the owner freezing it (and the agent refusing to spend) then unfreezing it, a private x402 payment, a cash out, a spot trade and proofs.

The NEAR Intents trade between two agents, end to end with no funds: `pnpm --filter @hushd/services intents:sandbox` deploys the exact code of `intents.near` (read from mainnet, hash checked) on a local node, and two agents deposit, trade with signed `token_diff`s, see a replay refused and withdraw. `intents:mainnet` prints the budgeted mainnet run and dry-runs it against `intents.near`.

Or, from a terminal, with no keys: `pnpm install && pnpm verify` checks the README's live claims against the deployment, one PASS or FAIL each (for NEAR Intents: a two-agent trade's signatures, keys and nonces checked by `intents.near`'s simulation on mainnet, with nothing sent).

## What to look at

| Claim | Code |
| --- | --- |
| Groth16 verified on chain with `alt_bn128` | `contracts/pool/src/groth16.rs`, `contracts/pool/src/lib.rs` (`transact`, `settle_swap`) |
| Both legs settle or neither | `contracts/pool/src/lib.rs` (`settle_swap`), `contracts/desk/src/lib.rs` (`settle`, `on_settled`) |
| Only the two parties can settle a deal: both sign its four outputs | `contracts/desk/src/lib.rs` (`settle`, `settle_message`), `packages/sdk/src/desk.ts` (`settleMessage`, `settleAsTrader`, `settleAsMaker`) |
| NEAR-specific static checks on every contract | `contracts/tools/near-scan`, [security/near-scan.md](security/near-scan.md) |
| A match must come from the enclave, and each quote carries its maker's consent | `contracts/desk/src/lib.rs` (`on_match`, `submit_match`, `accept_match`), `matcher/src/main.rs` |
| Makers never see the limit | `packages/sdk/src/desk.ts` (`packageRequest`, `openRfq`) |
| Each deal pays the trader at a one-time address, then a private send moves the note into its balance | `packages/sdk/src/desk.ts` (`dealIdentityFor`, `settleAsTrader`), `packages/sdk/src/wallet.ts` (`moveDealNote`), `packages/sdk/test/deal.test.ts` |
| The maker's hedge order is signed by Chain Signatures per deal and trades for the maker's own Hyperliquid account; a missed hedge, as the keeper reports it, pays the bond to the trader privately | `contracts/desk/src/hedge.rs`, `contracts/desk/src/lib.rs` (`sign_hedge_order`, `record_hedge`, `slash_overdue`), `services/src/hyperliquid.ts` (`approveDealAgent`), `services/src/makers.ts`, `services/src/keeper.ts`; a filled one on testnet: [deal 122](https://hushd.net/app/deals/122), `deployments/testnet-hedge.json` |
| Proofs for one reader with an expiry | `circuits/receipt/receipt.circom` (`context`), `packages/sdk/src/field.ts` (`proofContext`), `packages/sdk/src/proofs.ts` |
| NEAR AI intake is end-to-end encrypted and verified | `packages/sdk/src/intake.ts`, `services/src/intake.ts` |
| Private x402 | `packages/sdk/src/x402.ts` and its tests, `services/src/makers.ts` |
| Agents spend only inside limits | `packages/mcp/src/limits.ts`, `packages/mcp/test/mcp.test.ts` |
| Pay anyone as a link; the claim moves the payment into a note only the claimer knows, with no gas | `packages/sdk/src/links.ts` and `packages/sdk/test/links.test.ts`, `app/src/app/app/claim/page.tsx`, `app/e2e/claim.spec.ts` |
| Sanctions screening of public addresses only, in the app, the API and the relayer | `packages/sdk/src/screening.ts` and its tests, `services/src/relayer.ts` (`transact`), `services/src/api.ts` (`/v1/screen`) |
| A bond does not give a trade's size away: the desk takes bonds only in fixed steps | `contracts/desk/src/lib.rs` (`is_bond_step`), `packages/sdk/src/desk.ts` (`bondStepAtLeast`) |
| Agents and makers hold no NEAR key: policy wallets on OutLayer custody, policy stored and frozen on chain by the owner | `packages/sdk/src/custody.ts`, `services/scripts/policy-wallet.ts`, `services/src/makers.ts` (`makerAccount`), `packages/mcp/src/agent.ts` |
| Direct trades on NEAR Intents: NEP-413 signed `token_diff`s, simulated, then one `execute_intents` | `packages/sdk/src/intents.ts` and its tests, `services/src/intents-trade.ts`, `services/scripts/intents-sandbox.ts` |
| Bytes agree across TypeScript and both Rust codebases | `packages/protocol/test/protocol.test.ts`, `matcher/tests/interop.json`, `contracts/desk/src/hedge.rs` tests |

## Status and scope

- **Testnet, mainnet-ready.** Hushd runs on NEAR testnet with test tokens and development proving keys. The code is mainnet-ready on one code path: the mainnet build passes 17 of 17 checks end to end on a local node running the real mainnet USDC, `wrap.near` and nBTC contracts. Going live is a proving-key ceremony, an external audit and a deploy ([MAINNET.md](MAINNET.md)).
- **Security.** An internal contract review and automated scans: the High and all three Mediums are fixed, every Low is fixed or accepted with its reason, and every scan passes ([SECURITY.md](SECURITY.md)).
- **Trust model.** Who sees what, and what each Hushd service can and cannot do, is set out in the README's [privacy and security model](README.md#privacy-and-security-model).
- **NEAR Intents.** NEAR Intents has no testnet, so the two-agent trade runs on a local node with `intents.near`'s exact code, and the mainnet run is ready.
