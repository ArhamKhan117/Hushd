# Hushd on mainnet

Hushd runs on NEAR testnet today.
Every part of it is built to run on mainnet too: going live is the deploy below plus environment switches, with no code changes.
This page says what is ready, how it was tested before anything touched mainnet, and the steps to go live.

## How it was tested: the mainnet build in a sandbox

```bash
pnpm --filter @hushd/services mainnet:sandbox
```

[`services/scripts/mainnet-sandbox.ts`](services/scripts/mainnet-sandbox.ts) runs the mainnet build end to end on a local node:

- **The node:** near-sandbox at nearcore 2.14.0, the version mainnet runs (protocol 88, the same as testnet).
- **The real contracts Hushd uses:** native USDC (Circle's FiatToken at `17208628…36133a1`), `wrap.near` and `nbtc.bridge.near`, each at its mainnet account id with its exact mainnet code, checked against mainnet's code hash.
  Their mainnet balances are too large to copy, so each starts fresh and is funded the way its own code allows: USDC through Circle's minter roles (a multisig request approved by two operators), wNEAR by wrapping NEAR, BTC by its controller.
- **The deploy:** `scripts/deploy.ts` with the mainnet profile deploys `pool.hushd.near`, `desk.hushd.near` and `board.hushd.near` from the reproducible wasm.
  It then runs again once the makers hold tokens, which is how their inventory and bonds go in on mainnet.
- **The services:** relayer, API, indexer, matcher, three makers and keeper, all with `HUSHD_NETWORK=mainnet`.
- **The trading screen's prices:** the API's market routes answer on mainnet settings.
- **The flows:** an agent drives the MCP server's tools: shield, a private send to a second agent, two spot trades (USDC for wNEAR, wNEAR for BTC) matched in the sealed auction and settled privately, a cash out with the mainnet relayer fee, a payment proof checked by the pool, and a private x402 payment to a maker.
- **The books:** the pool's notes plus anything waiting to be claimed equal its real token balances, and the relayer received its fee.

Result on 9 November 2026: 17 of 17 checks pass.
The deploy moved 26.1 NEAR into the new accounts, most of it held there to pay for contract storage rather than spent.

Three things a sandbox cannot hold are stood in for:
- the matcher enclave runs as a local process (no TEE in a sandbox);
- OutLayer and the MPC signer are the test doubles from `contracts/sandbox-tests`;
- hedged deals trade on Hyperliquid mainnet, so they are not run here.

The run found two mainnet bugs, both fixed:
- On an empty database, the services raced each other creating tables; migrations hold a Postgres lock.
- The relayer was not registered for storage on the tokens, so its mainnet cash-out fee could not be paid (the pool kept it claimable).
  Testnet charges no fee, which is why testnet never showed it.

## What switches with the network

| Part | On mainnet | Switch |
| --- | --- | --- |
| Contracts | Same code. Every account, token, limit and the MPC and OutLayer ids are init arguments | `deploy:mainnet` |
| SDK | `MAINNET` names `*.hushd.near`, native USDC, `wrap.near`, `nbtc.bridge.near`, `v1.signer`, `outlayer.near` | `deployed: true` once live |
| App | Real tokens, no faucet, no relayer activation; a new passkey account is asked to send itself about 0.1 NEAR for gas | `NEXT_PUBLIC_HUSHD_NETWORK=mainnet` |
| MCP server | Runs on mainnet; the faucet tool refuses | `HUSHD_NETWORK=mainnet` |
| Relayer | 50 bps cash-out fee (none on testnet); faucet and activation off | `HUSHD_NETWORK` |
| Makers and keeper | Hedge (experimental) on Hyperliquid mainnet, for each maker's own account; a 1,000 USDC bond each | `HUSHD_NETWORK` (or `HYPERLIQUID_NETWORK`) |
| Matcher | OutLayer mainnet, project `hushd.near/matcher` | `HUSHD_NETWORK` |
| Indexer | FastNEAR's mainnet transactions API, or `INDEXER_SOURCE=rpc` for a self-run node | `HUSHD_NETWORK` |
| Policy wallets | OutLayer custody on mainnet | `HUSHD_NETWORK` |

## Going live, in order

1. **Proving keys.** Run a multi-party ceremony with `circuits/scripts/ceremony.mjs` (start, each contributor in turn, verify, a beacon from a NEAR mainnet block announced in advance).
   The development keys must never hold real value: whoever made them could forge proofs.
   Then `npm run publish-artifacts` and `npm run vk` in circuits/, and rebuild the pool reproducibly.
2. **The account.** Claim `hushd.near` and fund it with about 30 NEAR.
3. **Deploy.** `pnpm --filter @hushd/services deploy:mainnet` prints the plan; with the owner's yes, `HUSHD_MAINNET_GO=hushd.near` sends it.
   The pool starts with small caps (10,000 USDC per deposit and 100,000 in all, and the like for wNEAR and BTC), raised later through its one-day timelock.
4. **The matcher.** Create the OutLayer project `hushd.near/matcher` from the same build, generate its protected key in the TEE, pin the build in the desk's config, and call `refresh_enclave_key`.
5. **Makers.** Each maker account brings its inventory and 1,000 USDC of bond, then the deploy runs again to shield and post them; for hedged deals, margin on Hyperliquid mainnet.
6. **Services and app.** The same Docker images and app with `HUSHD_NETWORK=mainnet` and `NEXT_PUBLIC_HUSHD_NETWORK=mainnet`; set `deployed: true` in the SDK's `MAINNET`.
7. **Lock it.** Verify each contract on NearBlocks, then remove the deployer's full-access keys from the contract accounts.

Before step 3, run `mainnet:sandbox` again on the final commit.
