//! NEP-297 events, standard "hushd", version 1.0.0. No event names the poster:
//! the board exists so a recipient learns of a payment without anyone learning
//! who sent it, and an event is as public as storage.

use near_sdk::json_types::U64;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::json;
use near_sdk::log;

fn emit<T: Serialize>(event: &str, data: T) {
    let payload = json!({
        "standard": "hushd",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    log!("EVENT_JSON:{}", payload);
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Post<'a> {
    pub index: U64,
    pub bytes: u32,
    pub tag: Option<&'a str>,
}

pub fn post(e: Post) {
    emit("post", e)
}
pub fn max_post_bytes(max_post_bytes: u32) {
    emit("max_post_bytes", json!({ "max_post_bytes": max_post_bytes }))
}
