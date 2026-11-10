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
  Servers read FastNEAR and keep dRPC as `rpcFallback`; the browser reads `browserRpc` (dRPC) first (`forBrowser`): FastNEAR's 429 carries no CORS headers, so a browser logs every one as a CORS error, and there FastNEAR is only the fallback. A local stack and a browser share one address, so the split keeps each on its own quota. A browser network (`retryRateLimited`, set by `forBrowser`) asks a rate-limited dRPC once more after a pause before falling back; a server falls back at once.
- The app picks its network from `NEXT_PUBLIC_HUSHD_NETWORK` (testnet by default; `app/src/lib/hushd/config.ts`).
  Faucet and passkey activation are testnet only (`IS_TESTNET`); on mainnet a new passkey account waits for NEAR sent to it.
- Free dRPC refuses transactions with more than about 2 KB of arguments ("method is not available"), so it only serves reads: build signers on `sendEndpoints(net)`, never `net.rpc`.
- FastNEAR answers a rejected transaction with HTTP 400; call `keepRpcErrorBodies(net)` (every endpoint it reads, falls back to or sends through) before using near-kit or the reason (and near-kit's stale-nonce retry) is lost.
- The testnet contracts are reproducible builds: redeploy only the output of `cargo near build reproducible-wasm` (Docker, a clean committed tree; about 6 min a contract on Apple silicon). `redeploy-code.ts` refuses anything else, and `pnpm verify` fails a contract without NEP-330 `build_info`.
  Sandbox tests rebuild the same `target/near` paths non-reproducibly, so rebuild reproducibly before a redeploy. The commit a contract names must reach GitHub unchanged (no history rewrite) for NearBlocks to verify it.
- Mainnet is one code path with testnet: `HUSHD_NETWORK` (services, MCP) and `NEXT_PUBLIC_HUSHD_NETWORK` (app) pick everything. Never add a testnet-only constant; put it in the SDK's network config or a deploy profile (`services/scripts/deploy.ts`).
- `mainnet:sandbox` needs the doubles' wasm, a native matcher build (`cargo build --release --target <host>` in matcher/) and Postgres; it uses ports 9080 and 9787-9792 and database hushd_sandbox, so it runs beside the testnet stack. It patches mainnet account ids into the node; the real tokens' admin roles belong to the sandbox's operators.
- Mainnet cash outs pay the relayer a fee in the token itself: the relayer must be registered for storage on every token (the deploy does it).
- Design is graphite: no hue anywhere (accent is steel, `--accent` in `app/src/app/globals.css`). Shared parts: `hd-frame`, `hd-crop` (crop marks), `hd-sheen`, `Spotlight`, `Reveal`, `hd-index`, `hd-grid-lines`.
  CSS written outside an `@layer` beats Tailwind utilities (`fixed`, `absolute`, `bg-*`): put new classes in `@layer components`.
- Import stylesheets (and declare `next/font` fonts, `app/src/lib/fonts.ts`) only from the root layout: Next preloads a route's own CSS whenever a link to that route is prefetched, and the browser warns about every preload a page leaves unused. No CSS modules.
- The app's CSP (report-only) has no `'unsafe-eval'`, and the browser reports every string evaluated as code: Node's `assert` maps to `app/src/lib/assert-browser.cjs` in the browser build and zod runs jitless (`app/src/lib/zodJitless.ts`). Check a new browser dependency for `new Function`.
- The mark lives in `app/src/components/Logo.tsx` (paths); `node app/scripts/make-icons.mjs` redraws the favicon and app icons from it, and `tools/make_readme_art.py` the README art (Pillow).
- A second `next dev` beside another needs `NEXT_DIST_DIR=.next-<port>`; Next then rewrites `app/tsconfig.json` with those paths, so restore that file before committing.
  A testnet e2e run against `next dev` fails when any file under `app/` changes mid-run (a Fast Refresh full reload drops the unlocked key); while others edit, run it against `next build` and `next start` in their own `NEXT_DIST_DIR`.
- The API rate-limits per client in four budgets (`limitFor` in `services/src/api.ts`: market, makers, flow, rest). Local test runs share one address, so many parallel browsers can still exhaust the free RPCs (FastNEAR answers 429 without CORS headers, which a browser sees as "Failed to fetch").
- `PrivateWallet.planLeg` holds the notes it picks until `settled` or `release`: a wallet settling two deals at once never spends one note twice.
  A held note counts toward the balance even after a sync sees it spent, and the leg's change is an expected note from the start: deals overlap all the time on the makers.
- Deal rooms: a trader reads its room with `roomKeyFor(seed, refundBlinding)` and names it in its sealed plan (`replyTo`), never its address key; the API's `sweepDealRooms` deletes a room once its deal leaves matched/settling, and any message after a day.
- A trader receives each deal at `dealIdentityFor(id, refundBlinding)`, whose address is the request's `trader.address`: pass `dealIdentity` (from `packageRequest`) to `awaitMatch`. The maker's note is saved in the wallet's `dealNotes` before the trader's leg goes out, and `sync()` moves any not moved yet into the main balance (`moveDealNote`, one private send).
- The testnet e2e uses a stand-in intake model (its own key, routed in the test) whenever the API's NEAR AI attestation is unavailable. Parallel Playwright runs share `app/test-results` and wipe each other's traces: pass `--output <dir>`.
- Salted terms: clients salt requests only when the network's `termsSalt` is on, and it must match the enclave build the desk pins (`95cba282...` hashes salted terms, `7521d46a...` does not). Mainnet is salted from the start.
- Headless Chromium logs "GPU stall due to ReadPixels" for the landing's WebGL field on its first page: its software compositing path, not the page (launch with `--use-angle=metal` and it is gone).
- npm: `pnpm publish:packages` publishes protocol, sdk and mcp in that order; the `@hushd` scope is an npm org.
