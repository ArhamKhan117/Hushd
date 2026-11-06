@AGENTS.md

## Traps

- Proving keys are development keys: `app/public/circuits/*` and the verifying keys compiled into `contracts/pool` must come from the same `circuits/scripts/setup-dev-keys.mjs` run (`gen-vk-rs.mjs` writes the Rust side).
- The pool needs explicit gas from callers: a cash out takes at least 143 Tgas, `settle` about 200, `request_match` about 105. The relayer sets them.
- Calls that change standing state take exactly 1 yoctoNEAR: pool rule changes, pause and `claim`; desk `propose_config`/`apply_config`/`cancel_config`, `withdraw_bond`, `set_maker_active`; token `set_operator`.
  The desk's pool, bond token and MPC are fixed at init; other desk settings wait out `config_timelock_ns`.
- snarkjs keeps worker threads alive: scripts call `process.exit`, tests terminate `globalThis.curve_bn128`.
- The NEAR AI intake verifier (`@nearai/inference-sdk`) needs Node 24; everything else runs on Node 22.
- MCP over stdio needs a clean stdout: run it with `pnpm --silent`.
- A policy wallet's first `store_wallet_policy` sender becomes its only controller: the owner stores the policy before the agent ever sees the `wk_` key (`scripts/policy-wallet.ts` does it in that order).
- OutLayer's TEE does not read call arguments: token caps for agents live in the MCP server's limits, not in the custody policy.
- 1Click confidential quotes need a partner key (`ONECLICK_API_KEY`, sent as `X-API-Key`); public dry quotes need none.
- The free neardata stream is slower than testnet; the indexer defaults to FastNEAR's transactions API (`INDEXER_SOURCE=transactions`).
- RPC calls rotate across the free endpoints in `TESTNET.rpc` and rest one that rate-limits (`rpcOrder` in `packages/sdk/src/rpc.ts`); `app/csp.config.mjs` repeats that list as its default, so change both together.
- Free dRPC refuses transactions with more than about 2 KB of arguments ("method is not available"), so it only serves reads: build signers on `sendEndpoints(net)`, never `net.rpc`.
- FastNEAR answers a rejected transaction with HTTP 400; call `keepRpcErrorBodies(net.rpc)` before using near-kit or the reason (and near-kit's stale-nonce retry) is lost.
- npm: `pnpm publish:packages` publishes protocol, sdk and mcp in that order; the `@hushd` scope is an npm org.
