# Security

Hushd runs on NEAR testnet, with test tokens and development proving keys.
No outside firm has audited it.
This page lists what is checked, how to run every check yourself, what the last contract review found and what changed because of it.

## Report a problem

Please report privately through GitHub's **Report a vulnerability** (the Security tab of [ArhamKhan117/Hushd](https://github.com/ArhamKhan117/Hushd/security)).
Do not open a public issue for anything that could move funds, break privacy or fake a receipt.
It is testnet software, so there is no paid bug bounty.

## Run every check

```bash
cargo install --locked cargo-audit cargo-deny   # once
pnpm security                                   # writes security/report.md and security/near-scan.md
```

The last run is in [security/report.md](security/report.md): every check passes.

| Check | What it covers |
| --- | --- |
| near-scan | 22 NEAR detector classes on the parsed source of the four contracts; every hit needs a written reason |
| near-scan self-test | A deliberately broken contract trips each classic detector |
| cargo audit | RustSec advisories for every crate the contracts and the matcher enclave use |
| cargo deny | Advisories, licenses, crate sources and wildcard versions |
| Clippy | Rust lints with warnings as errors, contracts, tests and the enclave |
| pnpm audit | npm advisories for the production JavaScript dependencies, moderate and above |

### NEAR detectors (near-scan)

Solidity projects run Slither and publish verified source on a block explorer.
NEAR contracts are Rust compiled to wasm, so the same checks need other tools.
BlockSec's Rustle is the NEAR analyzer, but it needs LLVM 15 and cannot read code built by Rust 1.85 or later, which these contracts (Rust edition 2024) require.

So [`contracts/tools/near-scan`](contracts/tools/near-scan) parses each contract's Rust source with `syn` and runs the detector classes of the NEAR audit checklist, the same classes Rustle reports:

- callbacks without `#[private]`, and `#[private]` on a method no callback reaches;
- state written in a callback after a cross-contract call (reentrancy), callbacks that can panic, and promises whose result nothing reads;
- cross-contract calls without static gas;
- public state changes with no caller check, owner calls without 1 yoctoNEAR, and `#[payable]` methods that ignore the deposit;
- u64 and u128 in JSON arguments, return values and JSON structs;
- storage prefixes reused, contract state that can be defaulted, legacy collections changed without a write back, and storage charged before the buffered writes are flushed;
- unbounded loops, randomness from block data, dropped results of set inserts, narrowing casts, floating point, and release builds without overflow checks.

Every hit carries a reason in [`reviewed.txt`](contracts/tools/near-scan/reviewed.txt), and the scan fails on a hit without one or on a reason without a hit.
The [report](security/near-scan.md) lists each hit and its reason.
A test contract with one of each classic mistake ([`fixtures/broken`](contracts/tools/near-scan/fixtures/broken/src/lib.rs)) must trip every detector, so a detector cannot quietly stop working.

### Dependencies

- The contract wasm has no known vulnerability.
  `crypto-bigint` 0.5.5 (RUSTSEC-2026-0387) is in the lockfile only through near-sdk's host-side test VM; `cargo tree --target wasm32-unknown-unknown` shows it is in no contract.
- Two crates are unmaintained but have no known vulnerability: `wee_alloc` (near-sdk's wasm allocator) and `unsafe-libyaml` (host-side, test VM only).
  The exceptions and their reasons are in [`contracts/.cargo/audit.toml`](contracts/.cargo/audit.toml) and [`contracts/deny.toml`](contracts/deny.toml).
- The matcher enclave's 68 crates have no advisories.
- JavaScript: `zod` moved to 4.6.7 (memory exhaustion on oversized input; the hosted `/mcp` endpoint takes input from anyone), and `ws` and `underscore` are pinned to fixed versions.
  `elliptic` remains (low, no fixed version): it arrives through `circomlibjs`, and Hushd never calls it.
- Every dependency comes from crates.io or npm, with no git sources, and every license is on the allow list.

## Code on chain is the code here

Solidity projects publish verified source on a block explorer; on NEAR the same guarantee comes from reproducible builds.

- Every contract on testnet (pool, desk, board and the three tokens) is built with `cargo near build reproducible-wasm`, inside a Docker image pinned by digest (`sourcescan/cargo-near:0.21.1-rust-1.96.0`).
- Each answers `contract_source_metadata` (NEP-330) with the commit it was built from, that image and the build command, so anyone can rebuild it byte for byte.
- `near contract verify deployed-at <account> network-config testnet now` does exactly that: it reads the metadata, rebuilds the commit in the image and compares the hash with the code on chain.
  Run from a clean clone of the commit, it matches for every contract.
- NearBlocks' **Verify and Publish** (Contract Code tab) runs the same rebuild through SourceScan's testnet verifier and then shows the source next to the contract.
- `pnpm verify` checks that each contract account runs the code hash recorded in [`deployments/testnet.json`](deployments/testnet.json), that it names a commit of this repository and a pinned image, and that your own reproducible build hashes the same.

## Contract review, 6 November 2026

A fresh review of all four contracts against the NEAR audit checklist, with every cross-contract call traced by hand.
It found 1 High, 3 Medium and 6 Low, plus 11 notes.

| | Finding | Now |
| --- | --- | --- |
| H-1 | Anyone could settle a matched deal with legs of their own. A proof binds a leg only to the deal id, and anyone can prove empty legs, so a deal could be closed with no trade, or a trader could get a free option on a hedged deal. | Fixed. `desk.settle` needs both parties' signatures over the deal and its four outputs: the trader's per-deal owner key and the maker's quote key. The relayer checks them first too. |
| M-1 | The desk measured storage before its maps were flushed, so RFQs and maker entries were stored free. | Fixed: the desk flushes before charging. near-scan has a new detector for this mistake. |
| M-2 | The desk ran OutLayer's active matcher build, so the project owner could switch builds, and with them the enclave key, without the desk's timelock. | Fixed: `matcher_project` names one build (`owner/project@<wasm hash>`), and changing it waits out the 24-hour timelock. The desk has been pinned to build `7521d46a…` since 9 November, and OutLayer runs exactly that build for it. |
| M-3 | Anyone could register as a maker with any key, free, and one bad key broke every trader's request. | Fixed: the key must be hex, registering pays its storage and needs a deposit, and the SDK asks at most 32 makers, best bonded first. The `makers` view still returns the whole list (paging is planned). |
| L-1 | A maker could be slashed while a hedge order signed before the deadline had filled but was not yet reported. | Fixed: a signed order gets 10 minutes after the deadline to be reported. |
| L-2 | A slashed bond the pool kept refusing (its note already existed, or a limit changed) was stuck in the desk. | Fixed: the trader can name another note with the deal's owner key (`redirect_slash_payout`). A bond above the pool's per-deposit limit still cannot be paid as a note. |
| L-3 | A function-call key could change a maker's quote key. | Fixed: `register_maker` needs an attached deposit, so only a full-access key can call it. |
| L-4 | Owner-only changes without 1 yoctoNEAR: the board's size limit and the test token's `mint`. | The board is fixed. `mint` stays: it is the test token's owner seeding the makers. |
| L-5 | The pool pays the storage of shields and refund notes. | Accepted: an attacker spends more on gas than the pool loses. |
| L-6 | The test token's faucet registration can be refunded by unregistering. | Accepted for the test token. |

Two of the notes matter for anyone judging the trust model:

- The contract accounts still hold the deployer's full-access key, so the owner could replace the code; the timelocks bind the owner's settings, not a redeploy. The keys come off after the last redeploy.
- A deal whose settle callback runs out of gas would stay in `settling`; the callback has fixed gas measured in the sandbox tests, but there is no recovery path yet.

What held up, with the evidence in the review:

- Each nullifier is spent exactly once, including both legs of a swap and every failure path.
- The pool's token balance always equals what its notes hold plus what is waiting to be claimed.
- Each bond is locked, released or slashed at most once per deal.
- The hedge order the MPC signs is rebuilt by the desk from the maker-signed terms; neither the keeper nor the maker can change it.
- `ft_on_transfer` refuses the wrong token, the wrong message and an unknown sender in both the pool and the desk.

## Tests that guard the contracts

- 148 unit tests with real Groth16 proofs: pool 48, desk 69, board 24, token 7.
- 6 sandbox tests on a local nearcore with the real wasm: shield, send, cash out, a refund note, a settled swap through the desk, a bonded hedge signed by the MPC double, and a refused slash payout retried.
- The matcher's 7 tests, including byte vectors shared with the desk and the TypeScript protocol package.

## Trust and limits

- The proving keys are development keys from one machine, not a multi-party ceremony; mainnet waits for one (`circuits/scripts/ceremony.mjs`, see [MAINNET.md](MAINNET.md)).
- The matcher enclave sees requests and quotes in the clear; you trust OutLayer's attestation that it runs this repository's `matcher/` code.
- The relayer can refuse to send a proof, but it cannot change a recipient, an amount or a fee.
- The full trust model is on [hushd.net/docs/threat-model](https://hushd.net/docs/threat-model).
