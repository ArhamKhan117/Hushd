//! Hushd contracts on a real local nearcore (near-sandbox), driven with near-api.
//! One test binary; every test starts its own sandbox. Run from `contracts/`:
//!
//! ```text
//! cargo test -p sandbox-tests -- --nocapture --test-threads=1
//! ```
//!
//! Each test prints a gas table for the transactions it times.

mod common;
mod desk;
mod pool;
