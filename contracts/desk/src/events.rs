//! NEP-297 events, standard "hushd", version 1.0.0: everything the indexer reads.
//! Traders never appear: deals name the maker (a public market maker) and nothing else.

use near_sdk::log;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{json, Value};

pub fn emit(event: &str, data: Value) {
    log!(
        "EVENT_JSON:{}",
        json!({ "standard": "hushd", "version": "1.0.0", "event": event, "data": [data] })
    );
}

pub fn emit_t<T: Serialize>(event: &str, data: &T) {
    emit(event, near_sdk::serde_json::to_value(data).expect("event data"));
}
