//! TEST DOUBLE of the MPC signer contract (Chain Signatures), for the Hushd
//! sandbox tests only. It is never deployed anywhere but a local sandbox.
//!
//! `sign` answers at once with one fixed secp256k1 signature, whatever it is asked
//! to sign. The values are not a valid signature of anything.

use near_sdk::json_types::U64;
use near_sdk::serde_json::{json, Value};
use near_sdk::{near, PanicOnDefault};

pub const BIG_R: &str = "02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
pub const S: &str = "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988";

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MpcDouble {
    requests: u64,
    last_request: Option<String>,
}

#[near]
impl MpcDouble {
    #[init]
    pub fn new() -> Self {
        Self { requests: 0, last_request: None }
    }

    /// Same entry point as the MPC contract; returns the fixed signature.
    #[payable]
    pub fn sign(&mut self, request: Value) -> Value {
        self.requests += 1;
        self.last_request = Some(request.to_string());
        json!({ "Secp256k1": { "big_r": BIG_R, "s": S, "recovery_id": 0 } })
    }

    /// How many requests it signed and the last request, as JSON text.
    pub fn usage(&self) -> Value {
        json!({ "requests": U64(self.requests), "last_request": self.last_request })
    }
}
