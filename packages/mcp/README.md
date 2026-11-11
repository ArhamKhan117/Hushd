# @hushd/mcp

The Hushd MCP server: a private balance, private payments, private x402 and the Hushd OTC desk for AI agents on NEAR, inside spending limits the owner sets.

Hushd runs on NEAR testnet, with test tokens that have no value.

## Quick start

Node 22 or newer.

No install needed: `npx` fetches it.

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
- Claim links: `hushd_pay_link` pays anyone as a link they claim into their own private balance (no gas, no seed phrase), `hushd_claim_link` claims one, `hushd_my_links` and `hushd_take_back_link` follow up on the links the agent paid.
- Desk: `hushd_trade` (spot, spot with a Hyperliquid hedge, cash and carry), `hushd_my_deals`, `hushd_deal`, `hushd_desk_deals`, `hushd_makers`, `hushd_status`.
- Proofs: `hushd_prove` (a payment, funds held or desk volume, for one named NEAR account) and `hushd_verify_proof`.
- Agent economy: `hushd_pay_x402` pays an x402 resource from the private balance.

Every spending tool checks the per-payment and per-day limits first, and a token without a limit cannot be spent.
`hushd_send`, `hushd_cash_out` and `hushd_pay_x402` also obey the end date (`HUSHD_LIMITS_EXPIRE`) and the list of payees (`HUSHD_ALLOW_TO`): an x402 resource is paid only when its hushd1 address is on the list.
A link counts like any payment, and an agent limited to a list of payees may not pay one.
`hushd_trade` needs `min_receive`, the least the agent accepts, above zero: anyone can register as a maker, so the floor is what keeps a fill fair.

## Who guards the balance

The private balance is guarded by these limits, inside this MCP process, and nothing else enforces them.
The seed sits on the agent's machine (`~/.hushd/seed`, or `HUSHD_SEED`): anything that can read it, an agent with shell or file access included, can spend the whole balance without going through this server.
The relayer only sends what was proved: it does not know an agent's limits and does not check them.
So keep in the balance only what you would let the agent lose, and do not give an agent that can read the seed a larger one.
A policy wallet guards the agent's NEAR account in a TEE, but not the private balance.

## Settings

| Variable | Meaning |
| --- | --- |
| `HUSHD_LIMIT_PER_PAYMENT`, `HUSHD_LIMIT_PER_DAY` | Spending limits, `TOKEN=amount` pairs |
| `HUSHD_LIMITS_EXPIRE`, `HUSHD_ALLOW_TO` | The date the agent stops spending, and the hushd1 addresses and NEAR accounts it may pay (any, when unset) |
| `HUSHD_SEED` or `HUSHD_HOME` | The agent seed (64 hex), or the folder holding `seed` (default `~/.hushd`) |
| `HUSHD_NEAR_ACCOUNT`, `HUSHD_NEAR_PRIVATE_KEY` | A NEAR testnet account for shields and cash-outs (optional) |
| `HUSHD_API_URL`, `HUSHD_RPC_URL` | The Hushd API and the NEAR RPC (defaults: `https://api.hushd.net`, FastNEAR) |
| `HUSHD_APP_URL` | The app claim links open in (default `https://hushd.net`) |
| `HUSHD_CIRCUITS_DIR`, `HUSHD_CIRCUITS_URL` | Where the proving artifacts come from (default `https://hushd.net/circuits`, cached in `~/.hushd/circuits`) |

## Links

- Docs: https://hushd.net/docs/agents
- App: https://hushd.net
- Source: https://github.com/ArhamKhan117/Hushd (packages/mcp)
- License: MIT
