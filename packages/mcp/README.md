# @hushd/mcp

The Hushd MCP server: a private balance, private payments, private x402 and the Hushd OTC desk for AI agents on NEAR testnet, inside spending limits the owner sets.

## Use it

```bash
npx -y @hushd/mcp init        # a new agent seed in ~/.hushd/seed (mode 600)
claude mcp add hushd \
  -e HUSHD_LIMIT_PER_PAYMENT="USDC=100,wNEAR=50" \
  -e HUSHD_LIMIT_PER_DAY="USDC=500,wNEAR=250" \
  -- npx -y @hushd/mcp
```

Without a seed the server serves the read tools only.
The read tools are also hosted: `claude mcp add --transport http hushd-read https://hushd.net/mcp`.

## Tools

- Wallet: `hushd_address`, `hushd_balance`, `hushd_faucet`, `hushd_shield`, `hushd_send`, `hushd_cash_out`, `hushd_limits`, `hushd_my_payments`.
- Desk: `hushd_trade` (spot, spot with a Hyperliquid hedge, cash and carry), `hushd_my_deals`, `hushd_deal`, `hushd_desk_deals`, `hushd_makers`, `hushd_status`.
- Proofs: `hushd_prove` (a payment, funds held or desk volume, for one named NEAR account) and `hushd_verify_proof`.
- Agent economy: `hushd_pay_x402` pays an x402 resource from the private balance.

Every spending tool checks the per-payment and per-day limits first, and a token without a limit cannot be spent.

## Settings

| Variable | Meaning |
| --- | --- |
| `HUSHD_LIMIT_PER_PAYMENT`, `HUSHD_LIMIT_PER_DAY` | Spending limits, `TOKEN=amount` pairs |
| `HUSHD_SEED` or `HUSHD_HOME` | The agent seed (64 hex), or the folder holding `seed` (default `~/.hushd`) |
| `HUSHD_NEAR_ACCOUNT`, `HUSHD_NEAR_PRIVATE_KEY` | A NEAR testnet account for shields and cash-outs (optional) |
| `HUSHD_API_URL`, `HUSHD_RPC_URL` | The Hushd API and the NEAR RPC (defaults: `https://api.hushd.net`, FastNEAR) |
| `HUSHD_CIRCUITS_DIR`, `HUSHD_CIRCUITS_URL` | Where the proving artifacts come from (default `https://hushd.net/circuits`, cached in `~/.hushd/circuits`) |

Docs: https://hushd.net/docs. Source: https://github.com/ArhamKhan117/Hushd.
