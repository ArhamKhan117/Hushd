# Hushd

A private OTC desk on NEAR testnet, run by AI agents.
Traders and agents hold a private balance in a shielded pool, ask makers for a price without showing their hand, settle both legs in one private call, and prove single facts (a payment, funds held, desk volume) to one named NEAR account.

## Layout

- `contracts/` (Rust, near-sdk 5, cargo-near): `pool` (notes, Groth16 on alt_bn128, Poseidon tree, nullifiers, `settle_swap`, `verify_disclosure`), `desk` (makers and bonds, RFQ commitments, enclave matches, settlement, receipts, Chain Signatures hedges, slashing), `board` (sealed note posts), `token` (test NEP-141 with a faucet), `sandbox-tests`.
- `circuits/` (circom 2): `joinsplit`, `receipt`, `funds`, `volume`; development keys only (`circuits/KEYS.md`).
- `matcher/` (Rust, WASI P2): the OutLayer enclave that opens sealed requests and quotes and signs the match.
- `packages/sdk` (`@hushd/sdk`): notes, proving, the private wallet, desk flows, proofs, x402, NEAR AI intake. `packages/protocol`: package terms and the bytes both sides sign. `packages/mcp`: the MCP server.
- `services/`: relayer, API (with NEAR AI intake), indexer, matcher client, three reference makers, keeper, top-up; one entrypoint `src/main.ts <service>`.
- `app/` (Next.js): the site, the app under `/app`, `/verify`, hosted MCP at `/mcp`.
- `deploy/`: Dockerfile, compose and Caddy for the services VM. `skills/hushd/SKILL.md`: the agent skill.

## Commands

```bash
pnpm install
pnpm test                                   # SDK, services, MCP, circuits (unit)
pnpm dev                                    # the app on :3000, against testnet
pnpm verify                                 # every README claim, checked live, PASS/FAIL
pnpm mcp init && pnpm --silent mcp          # local MCP server with an agent seed
cd contracts && cargo test -p hushd-pool -p hushd-desk -p hushd-board -p hushd-token  # unit tests, real proofs
pnpm --filter @hushd/services deploy:testnet  # deploy from a funded hushd.testnet
```

Sandbox tests need prebuilt wasm (`cargo near build non-reproducible-wasm` in each contract and in `sandbox-tests/doubles/*`), then `cargo test -p sandbox-tests -- --test-threads=1`.

## Rules

- Testnet only. Never deploy to mainnet or sign a mainnet transaction.
- Privacy is real or absent: never fake a proof, a match or a settlement, and never show invented numbers in the app.
- Bytes are pinned across languages (TS, Rust contracts, Rust matcher): change `packages/protocol`, `contracts/desk/src/lib.rs` (consent and match bytes), `contracts/desk/src/hedge.rs` and `matcher/src/terms.rs` together and keep their vector tests passing.
- Keys live in gitignored `.env` files only. `.env.example` lists every variable.
- Plain language in the UI and docs; light and dark themes; no em dashes.
