# Hushd

A private OTC desk on NEAR, run by AI agents.
Traders and agents hold a private balance in a shielded pool, ask makers for a price without showing their hand, settle both legs in one private call, and prove single facts (a payment, funds held, desk volume) to one named NEAR account.
It runs on NEAR testnet at https://hushd.net, and the same code runs on mainnet ([MAINNET.md](MAINNET.md)).

This file is the map of the repository for AI coding agents and anyone new to it.

## Layout

- `contracts/` (Rust, near-sdk 5, cargo-near): `pool` (notes, Groth16 on alt_bn128, Poseidon tree, nullifiers, `settle_swap`, `verify_disclosure`), `desk` (makers and bonds, RFQ commitments, enclave matches, settlement, receipts, Chain Signatures hedges, slashing), `board` (sealed note posts), `token` (test NEP-141 with a faucet), `sandbox-tests`.
- `circuits/` (circom 2): `joinsplit`, `receipt`, `funds`, `volume`, with development keys (`circuits/KEYS.md`) and a multi-party ceremony for mainnet keys.
- `matcher/` (Rust, WASI P2): the OutLayer enclave that opens sealed requests and quotes and signs the match.
- `packages/sdk` ([`@hushd/sdk`](https://www.npmjs.com/package/@hushd/sdk)): notes, proving, the private wallet, claim links, desk flows, proofs, x402, NEAR AI intake, NEAR Intents and OutLayer policy wallets.
- `packages/protocol` ([`@hushd/protocol`](https://www.npmjs.com/package/@hushd/protocol)): package terms, exact integer math and the bytes both sides sign.
- `packages/mcp` ([`@hushd/mcp`](https://www.npmjs.com/package/@hushd/mcp)): the MCP server for agents, with spending limits.
- `services/`: relayer, API (with NEAR AI intake and 1Click quotes), indexer, matcher client, three reference makers acting through policy wallets, keeper, top-up and the Agent Market worker; one entrypoint, `src/main.ts <service>`.
- `app/` (Next.js): the site, the app under `/app`, `/verify`, and the hosted MCP server at `/mcp`.
- `deploy/`: Dockerfile, Docker Compose and Caddy for the services. `skills/hushd/SKILL.md`: the agent skill.
- `deployments/`: what is deployed on testnet, with code hashes and transactions.

## Commands

```bash
pnpm install
pnpm test                                   # SDK, protocol, services, MCP and circuits
pnpm dev                                    # the app on :3000, against testnet
pnpm verify                                 # every README claim, checked live: PASS or FAIL
pnpm security                               # near-scan, cargo audit and deny, Clippy, pnpm audit -> security/report.md
pnpm mcp init && pnpm --silent mcp          # a local MCP server with a new agent seed
cd contracts && cargo test -p hushd-pool -p hushd-desk -p hushd-board -p hushd-token  # contract tests, with real proofs
pnpm --filter @hushd/services deploy:testnet  # deploy your own copy from one funded account (DRY_RUN=1 prints the plan)
pnpm --filter @hushd/services deploy:mainnet  # the mainnet plan (it sends only with HUSHD_MAINNET_GO set)
pnpm --filter @hushd/services mainnet:sandbox # the mainnet build end to end on a local node with the real USDC, wrap.near and nBTC code
pnpm --filter @hushd/services intents:sandbox # the NEAR Intents trade on a local node running intents.near's code
pnpm --filter @hushd/services hedge:check [--run] # the hedge leg on Hyperliquid testnet
pnpm --filter circuits ceremony start|contribute <name>|verify|finalize <height>  # multi-party proving keys
pnpm --filter @hushd/services policy-wallet create|show|freeze|unfreeze <ENV_PREFIX>  # an agent's OutLayer policy wallet
pnpm build:packages                         # protocol, sdk and mcp to dist/ for npm
```

Sandbox tests need prebuilt wasm (`cargo near build non-reproducible-wasm` in each contract and in `sandbox-tests/doubles/*`), then `cargo test -p sandbox-tests -- --test-threads=1`.

## Conventions

- Privacy is real or absent: never fake a proof, a match or a settlement, and never show invented numbers in the app.
- Bytes are pinned across languages (TypeScript, the Rust contracts, the Rust matcher): change `packages/protocol`, `contracts/desk/src/lib.rs` (consent and match bytes), `contracts/desk/src/hedge.rs` and `matcher/src/terms.rs` together, and keep their vector tests passing.
- Contracts are reproducible builds: deploy only the output of `cargo near build reproducible-wasm` from a clean, committed tree, so each contract names the commit and image it was built from (NEP-330) and verifies on NearBlocks.
- Mainnet and testnet share one code path: `HUSHD_NETWORK` (services, MCP) and `NEXT_PUBLIC_HUSHD_NETWORK` (app) pick everything; network constants live in the SDK's network config (`packages/sdk/src/network.ts`).
- Keys live in gitignored `.env` files only; `.env.example` lists every variable.
- Plain language in the UI and docs, in light and dark themes.
