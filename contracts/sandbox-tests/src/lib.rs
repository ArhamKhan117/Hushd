//! Integration tests for the Hushd contracts on a real local nearcore.
//!
//! Everything lives under `tests/`: this crate has no library code. Build the
//! contracts and the two test doubles first (see `tests/sandbox/common.rs`), then
//! run `cargo test -p sandbox-tests -- --nocapture --test-threads=1`.
