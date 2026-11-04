//! TEST DOUBLE of the OutLayer contract, for the Hushd sandbox tests only. It is
//! never deployed anywhere but a local sandbox.
//!
//! The real OutLayer runs the named project in a TEE worker and resumes the
//! caller's promise with the worker's output. This double answers at once:
//! - `{"cmd":"pubkey"}` returns the two enclave keys given at init;
//! - `{"cmd":"match", ..., "batch":"<string>"}` returns `batch` verbatim, so a
//!   test writes the matcher's whole answer into the sealed batch it sends.
//!
//! It keeps the attached deposit, like the real fee.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct OutLayerDouble {
    sign_key: String,
    enc_key: String,
    requests: u64,
    fees: u128,
    last_payer: Option<AccountId>,
}

#[near]
impl OutLayerDouble {
    /// `sign_key` and `enc_key` are 0x hex, 32 bytes each.
    #[init]
    pub fn new(sign_key: String, enc_key: String) -> Self {
        Self { sign_key, enc_key, requests: 0, fees: 0, last_payer: None }
    }

    /// Same signature as OutLayer's; only `input_data` and `payer_account_id` are read.
    #[payable]
    #[allow(unused_variables)]
    pub fn request_execution(
        &mut self,
        code_source: Value,
        resource_limits: Value,
        input_data: String,
        secrets_ref: Option<Value>,
        response_format: String,
        payer_account_id: Option<AccountId>,
    ) -> String {
        let input: Value = serde_json::from_str(&input_data).unwrap_or_else(|_| env::panic_str("input_data is not JSON"));
        self.requests += 1;
        self.fees += env::attached_deposit().as_yoctonear();
        self.last_payer = payer_account_id;
        match input["cmd"].as_str() {
            Some("pubkey") => json!({ "success": true, "result": { "sign_key": self.sign_key, "enc_key": self.enc_key } }).to_string(),
            Some("match") => input["batch"].as_str().unwrap_or_else(|| env::panic_str("match input has no batch string")).to_string(),
            _ => env::panic_str("unknown cmd"),
        }
    }

    /// How many requests it answered, the fees it kept and the last payer named.
    pub fn usage(&self) -> Value {
        json!({ "requests": U64(self.requests), "fees": U128(self.fees), "last_payer": self.last_payer })
    }
}
