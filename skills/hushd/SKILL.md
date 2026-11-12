---
name: hushd
description: Use Hushd, a private OTC desk on NEAR testnet where agents quote, trade and settle. Covers holding a private balance, paying privately, paying x402 resources privately, trading on the desk (spot, and the experimental spot with a hedge and cash and carry), and proving a payment, funds or desk volume to one named NEAR account. Use when an agent needs to move or trade value on NEAR without making its payments public, or needs to prove a single fact about private money.
---

# Hushd

Hushd keeps money as private notes in a pool contract on NEAR testnet.
Only the holder of the seed can spend a note.
A relayer sends every proven action, so the agent's NEAR account is not linked to its payments.

## Connect

Hosted, read-only and live now (status, makers, deals, proof checks), with no keys and nothing to install:

```bash
claude mcp add --transport http hushd-read https://hushd.net/mcp
```

The full MCP server, with the agent's own seed and spending limits, is `@hushd/mcp` on npm (22 tools):

```bash
npx -y @hushd/mcp init
claude mcp add hushd -e HUSHD_LIMIT_PER_PAYMENT="USDC=100" -e HUSHD_LIMIT_PER_DAY="USDC=500" -- npx -y @hushd/mcp
```

From a checkout of the repo, `pnpm mcp init` and `pnpm --silent --dir "$PWD" mcp` run the same server.

To add tokens the agent also needs a NEAR testnet account.
Best is a policy wallet, so the agent holds no NEAR key: the owner runs `pnpm --filter @hushd/services policy-wallet create MY_AGENT` (or uses the Agents page) and the agent gets `HUSHD_POLICY_WALLET_KEY`.
OutLayer's TEE then signs only calls to Hushd's contracts within the owner's caps, and the owner can freeze it on chain.
Otherwise set `HUSHD_NEAR_ACCOUNT` and `HUSHD_NEAR_PRIVATE_KEY`.
`hushd_policy` tells the agent which it has, the TEE's rules and whether it is frozen.

## Typical flow

1. `hushd_address`: the agent's `hushd1...` receive address.
2. `hushd_faucet` then `hushd_shield`: test tokens to the NEAR account, then into the private balance.
3. `hushd_balance`: always sync before deciding what can be spent.
4. Pay: `hushd_send` to a `hushd1...` address, `hushd_cash_out` to a NEAR account, or `hushd_pay_x402` for a URL that answers 402 with scheme `hushd`.
   To pay someone not on Hushd yet, `hushd_pay_link` returns a claim link (`https://hushd.net/app/claim#...`); whoever opens it first claims the payment with a passkey or a NEAR wallet and no gas.
   `hushd_my_links` shows whether each link is waiting or claimed, and `hushd_take_back_link` takes back one nobody claimed.
   If the agent is paid with a link, `hushd_claim_link` claims it into its own balance.
5. Trade: `hushd_trade` with `kind` spot, spot_hedge or carry, the sell token and amount, the buy token and `min_receive`, the least you accept (required, above zero).
   Work `min_receive` out from a fair price less the slippage you accept: anyone can register as a maker, so a low floor can be filled at a low price.
   The request and its limit are sealed to the matcher enclave; makers only see the pair, side and size.
   Spot settles atomically in the pool.
   The hedge kinds are experimental: the agent receives the same spot leg, and the maker commits, with its bond, to place a Hyperliquid testnet hedge order for its own account, so the position is the maker's, not the agent's.
   If that order misses, the bond is paid to the agent privately. Makers quote a hedged kind only when they can place the hedge, so expect no match otherwise.
6. Prove: `hushd_prove` with `what` payment, payment_at_least, funds or volume, a `reader` NEAR account and `days` of validity.
   Give the reader the `check_at` link; `hushd_verify_proof` checks one.

## Rules for agents

- Never print, log or send the seed (`~/.hushd/seed` or `HUSHD_SEED`). It spends everything.
- Respect the limits. A refusal from a limit is final for that call; ask the operator to raise the limit rather than splitting a payment to get around it.
  The limits run in the local MCP server, beside the seed; the relayer does not enforce them. An x402 payment obeys the payee list and the end date like a send.
- Amounts are in token units ("25.5"), not base units.
- Deposits (`hushd_shield`) and cash outs are public on NEAR. Payments, trades and balances inside the pool are not.
- A claim link is the payment itself: anyone holding it can claim it. Send it only to the intended payee, over a private channel, and never log it.
- A proof shows one fact to one reader until it expires. Make a new proof for each reader.
- Testnet only: the tokens are test tokens and the proving keys are development keys.

## SDK

For code instead of MCP, use `@hushd/sdk` (`npm install @hushd/sdk`): `PrivateWallet` (sync, send, cashOut, shield), `payAsLink`, `claimLink`, `openRfq`, `awaitMatch`, `settleAsTrader`, `proveReceipt`, `proveFunds`, `proveVolume`, `verifyProof`, `x402Fetch` and `verifyX402Payment`.
See `packages/mcp/src/tools.ts` for each tool's exact use of the SDK.
