@AGENTS.md

## Traps

- Proving keys are development keys: `app/public/circuits/*` and the verifying keys compiled into `contracts/pool` must come from the same `circuits/scripts/setup-dev-keys.mjs` run (`gen-vk-rs.mjs` writes the Rust side).
- The pool needs explicit gas from callers: a cash out takes at least 143 Tgas, `settle` about 200, `request_match` about 105. The relayer sets them.
- Calls that change standing state take exactly 1 yoctoNEAR: pool rule changes, pause and `claim`; desk `propose_config`/`apply_config`/`cancel_config`, `withdraw_bond`, `set_maker_active`; board `set_max_post_bytes`; token `set_operator`.
  The desk's pool, bond token and MPC are fixed at init; other desk settings wait out `config_timelock_ns`.
- snarkjs keeps worker threads alive: scripts call `process.exit`, tests terminate `globalThis.curve_bn128`.
- The NEAR AI intake verifier (`@nearai/inference-sdk`) needs Node 24; everything else runs on Node 22.
- MCP over stdio needs a clean stdout: run it with `pnpm --silent`.
- A policy wallet's first `store_wallet_policy` sender becomes its only controller: the owner stores the policy before the agent ever sees the `wk_` key (`scripts/policy-wallet.ts` does it in that order).
- OutLayer's TEE does not read call arguments: token caps for agents live in the MCP server's limits, not in the custody policy.
- 1Click confidential quotes need a partner key (`ONECLICK_API_KEY`, sent as `X-API-Key`); public dry quotes need none.
- The free neardata stream is slower than testnet; the indexer defaults to FastNEAR's transactions API (`INDEXER_SOURCE=transactions`).
- RPC calls rotate across the free endpoints in `TESTNET.rpc` (or `MAINNET.rpc`) and rest one that rate-limits (`rpcOrder` in `packages/sdk/src/rpc.ts`); `app/csp.config.mjs` repeats both lists as its defaults, so change both together.
- The app picks its network from `NEXT_PUBLIC_HUSHD_NETWORK` (testnet by default; `app/src/lib/hushd/config.ts`).
  Faucet and passkey activation are testnet only (`IS_TESTNET`); on mainnet a new passkey account waits for NEAR sent to it.
- Free dRPC refuses transactions with more than about 2 KB of arguments ("method is not available"), so it only serves reads: build signers on `sendEndpoints(net)`, never `net.rpc`.
- FastNEAR answers a rejected transaction with HTTP 400; call `keepRpcErrorBodies(net.rpc)` before using near-kit or the reason (and near-kit's stale-nonce retry) is lost.
- The testnet contracts are reproducible builds: redeploy only the output of `cargo near build reproducible-wasm` (Docker, a clean committed tree; about 6 min a contract on Apple silicon). `redeploy-code.ts` refuses anything else, and `pnpm verify` fails a contract without NEP-330 `build_info`.
  Sandbox tests rebuild the same `target/near` paths non-reproducibly, so rebuild reproducibly before a redeploy. The commit a contract names must reach GitHub unchanged (no history rewrite) for NearBlocks to verify it.
- Mainnet is one code path with testnet: `HUSHD_NETWORK` (services, MCP) and `NEXT_PUBLIC_HUSHD_NETWORK` (app) pick everything. Never add a testnet-only constant; put it in the SDK's network config or a deploy profile (`services/scripts/deploy.ts`).
- `mainnet:sandbox` needs the doubles' wasm, a native matcher build (`cargo build --release --target <host>` in matcher/) and Postgres; it uses ports 9080 and 9787-9792 and database hushd_sandbox, so it runs beside the testnet stack. It patches mainnet account ids into the node; the real tokens' admin roles belong to the sandbox's operators.
- Mainnet cash outs pay the relayer a fee in the token itself: the relayer must be registered for storage on every token (the deploy does it).
- npm: `pnpm publish:packages` publishes protocol, sdk and mcp in that order; the `@hushd` scope is an npm org.
