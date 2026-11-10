# For judges

A five-minute path through Hushd, then where to look in the code.

## Five minutes

1. Open [hushd.net/app](https://hushd.net/app) and sign in with a passkey (no wallet needed; the relayer opens the account on testnet).
2. Balance, then Add privately: the faucet gives test USDC and one click moves it into the pool.
3. Desk, then Describe it: type "sell 500 USDC for BTC at the best price". The draft comes from a NEAR AI model in a TEE; the line under the box shows the attestation the API verified, and the draft shows the signature your browser checked. (Or use Fill the form: Spot, 500 USDC, BTC.)
4. Ask for quotes and watch the steps: committed on chain, sealed quotes arriving, matched in the enclave, settled in the pool. Open the deal page: the chain shows a deal and an outcome, not the amounts or you. Or trade from [Trade](https://hushd.net/app/trade): the same flow beside a live chart, with your deal settling in the panel below.
5. Prove, then Exact payment for that deal, reader `judge.testnet`, then open the link. The checker verifies the proof in your browser and asks the pool contract to check it again.

Already made for you: `deployments/judge-proof-payment.txt` (an exact payment that settled desk deal #2) and `deployments/judge-proof-funds.txt` (a balance of at least 1,000 USDC, from a wallet that only backs it), both for `judge.testnet`, until 6 and 10 December 2026. The pool checks each against its reader and expiry on chain. Paste one into [hushd.net/verify](https://hushd.net/verify) as `judge.testnet`, then as anyone else to see it refused.

Watch an agent do all of it: `pnpm stack` in one terminal, then `pnpm --filter @hushd/services exec tsx scripts/demo-agent.ts`. It drives the MCP server's tools through the agent's policy wallet: a deposit signed in OutLayer's TEE, a call outside its policy refused by the TEE, the owner freezing it (and the agent refusing to spend) then unfreezing it, a private x402 payment, a cash out, a spot trade and proofs, then a request for a hedged trade, which no maker quotes until a maker's Hyperliquid testnet account holds margin.

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
| The maker's hedge order is signed by Chain Signatures per deal and trades for the maker's own Hyperliquid account; a missed hedge, as the keeper reports it, pays the bond to the trader privately | `contracts/desk/src/hedge.rs`, `contracts/desk/src/lib.rs` (`sign_hedge_order`, `record_hedge`, `slash_overdue`), `services/src/hyperliquid.ts` (`approveDealAgent`), `services/src/makers.ts`, `services/src/keeper.ts` |
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

## Honest limits

- Testnet only, with test tokens and development proving keys.
- The contracts had an internal review, not an external audit.
- Hedged packages are experimental. The hedge order trades on Hyperliquid testnet for the maker's own account (each deal's Chain Signatures address is approved as the maker's agent), so it does not hedge the trader, and Hyperliquid shows all of one maker's hedges on that maker's account. What the trader gets beyond the spot leg is the maker's bond if the order misses.
- No hedge has filled: the reference makers' Hyperliquid testnet accounts hold no margin, so they do not quote hedged packages, and the one hedged deal so far (#3) ended with its bond paid to the trader.
- The keeper alone reports a hedge's outcome, and the desk releases or slashes the bond on that report.
- The winning maker pays a one-time address per deal, so it cannot link a trader's deals by address; their pairs, sizes and timing can still hint at it.
- Makers have a last look: the trader proves its leg first and the maker submits both, so a maker can wait out the settlement window and settle only if the price still suits it. It loses no bond on a spot deal, but the lapse is public and requests skip a maker that let more than 25% of its recent deals lapse (`packages/sdk/src/reputation.ts`).
- Hushd's own services are trusted for some things: the API sees IP addresses, timing and deal-room traffic, and the matcher client builds the enclave's batch from the API's database, so it could leave a quote out without the enclave knowing.
- The makers are automated agents that price by formula (a fixed, a volatility or an inventory spread on Hyperliquid mids); the one language model in Hushd is the NEAR AI intake.
- A policy wallet's TEE checks which contracts an agent calls and the NEAR it attaches, not the token amounts inside a call; those limits are the MCP server's.
- NEAR Intents has no testnet: the direct trade is tested on a local node running `intents.near`'s code, and the mainnet run (about 3 USD, mostly returned) waits for the owner's go-ahead.
- The NEAR Intents Agent API (mainnet only) is wired (`services/src/agent-api.ts`, `scripts/agent-api.ts`: an agent owned by the demo's dev wallet, its policy signed by that key, swaps through a grant) and checked against the live API's public endpoints; creating the agent waits for a partner key and the owner's go-ahead.
- The contract review and automated scans, with every finding and fix: [SECURITY.md](SECURITY.md).
- Deposits and cash outs are public, and timing can link them; the docs say how to reduce that.
- A hedged deal's hedge order is public on Hyperliquid, so its size is not private; its bond shows only a size step.
- Sanctions screening uses a dated snapshot of OFAC's list and covers public addresses only.
- An agent's private balance is guarded by its local MCP server's limits, not by the relayer: whatever can read the seed can spend it.
