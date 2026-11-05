---
name: hushd
description: Use Hushd, a private OTC desk on NEAR testnet run by agents. Covers holding a private balance, paying privately, paying x402 resources privately, trading on the desk (spot, spot with a Hyperliquid hedge, cash and carry), and proving a payment, funds or desk volume to one named NEAR account. Use when an agent needs to move or trade value on NEAR without making its payments public, or needs to prove a single fact about private money.
---

# Hushd

Hushd keeps money as private notes in a pool contract on NEAR testnet.
Only the holder of the seed can spend a note.
A relayer sends every proven action, so the agent's NEAR account is not linked to its payments.

## Connect

Local MCP server, with the agent's own seed and spending limits (from a checkout of the repo):

```bash
pnpm install
pnpm mcp init
claude mcp add hushd -e HUSHD_LIMIT_PER_PAYMENT="USDC=100" -e HUSHD_LIMIT_PER_DAY="USDC=500" -- pnpm --silent --dir "$PWD" mcp
```

Hosted, read-only (status, makers, deals, proof checks): `https://hushd.net/mcp` (Streamable HTTP).

To add tokens the agent also needs a NEAR testnet account: set `HUSHD_NEAR_ACCOUNT` and `HUSHD_NEAR_PRIVATE_KEY`.

## Typical flow

1. `hushd_address`: the agent's `hushd1...` receive address.
2. `hushd_faucet` then `hushd_shield`: test tokens to the NEAR account, then into the private balance.
3. `hushd_balance`: always sync before deciding what can be spent.
4. Pay: `hushd_send` to a `hushd1...` address, `hushd_cash_out` to a NEAR account, or `hushd_pay_x402` for a URL that answers 402 with scheme `hushd`.
5. Trade: `hushd_trade` with `kind` spot, spot_hedge or carry, the sell token and amount, the buy token and optionally `min_receive`.
   The request and its limit are sealed to the matcher enclave; makers only see the pair, side and size.
   Spot settles atomically in the pool; the hedge kinds add a Hyperliquid testnet order backed by the maker's bond.
6. Prove: `hushd_prove` with `what` payment, payment_at_least, funds or volume, a `reader` NEAR account and `days` of validity.
   Give the reader the `check_at` link; `hushd_verify_proof` checks one.

## Rules for agents

- Never print, log or send the seed (`~/.hushd/seed` or `HUSHD_SEED`). It spends everything.
- Respect the limits. A refusal from a limit is final for that call; ask the operator to raise the limit rather than splitting a payment to get around it.
- Amounts are in token units ("25.5"), not base units.
- Deposits (`hushd_shield`) and cash outs are public on NEAR. Payments, trades and balances inside the pool are not.
- A proof shows one fact to one reader until it expires. Make a new proof for each reader.
- Testnet only: the tokens are test tokens and the proving keys are development keys.

## SDK

For code instead of MCP, use `@hushd/sdk` from this repo: `PrivateWallet` (sync, send, cashOut, shield), `openRfq`, `awaitMatch`, `settleAsTrader`, `proveReceipt`, `proveFunds`, `proveVolume`, `verifyProof`, `x402Fetch` and `verifyX402Payment`.
See `packages/mcp/src/tools.ts` for each tool's exact use of the SDK.
