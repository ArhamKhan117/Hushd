# Hushd testnet keys

These are the Groth16 keys the testnet contracts and the app use today.
They are development keys: fine for testnet, not for mainnet.

## How they were made

1. Powers of Tau: the public Perpetual Powers of Tau ceremony, prepared for 2^16 constraints (`ppot_0080_16.ptau`, sha256 `ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9`).
2. Phase 2, per circuit: one contribution with 64 bytes of fresh random entropy held only in memory by `scripts/setup-dev-keys.mjs`, then a public beacon: the hash of NEAR mainnet block 223,247,205 (`8kJ7Q27wWASLGamyz9Tq56mKhtRKvzAuSwPkyZBAzQdu`), 2^10 iterations.
3. Each final key was checked against its circuit and the Powers of Tau file (`snarkjs zkey verify`).

## What that means

Whoever ran the script could have kept the entropy of the single contribution, and with it could make proofs these keys accept without the secrets behind them.
That is why these keys are for testnet only.
A mainnet deployment needs a multi-party phase-2 ceremony, where one honest contributor is enough.

## Transcript

| Circuit | Constraints | Public inputs | r1cs sha256 | Final key sha256 |
| --- | --- | --- | --- | --- |
| `joinsplit` | 13,280 | 8 | `17e8e7a465c7725d…` | `568e5e848282e5cb…` |
| `receipt` | 1,847 | 9 | `dcfd7c1feed3657c…` | `a10799e03366aa6a…` |
| `funds` | 24,056 | 8 | `47dffc84e5320af9…` | `50cbcbe569f00927…` |
| `volume` | 29,678 | 5 | `efd9e041139179cb…` | `0b0317c37e49e8e4…` |

The browser copies live in `app/public/circuits/` with their sha256 in `manifest.json`.
The contract's verifying keys are generated from the same files into `contracts/pool/src/vk.rs` by `scripts/gen-vk-rs.mjs`.
