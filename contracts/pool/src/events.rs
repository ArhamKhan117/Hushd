//! NEP-297 events, everything the indexer reads. Standard "hushd", version 1.0.0.

use crate::field::FieldStr;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::serde_json::json;
use near_sdk::{log, AccountId};

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
pub struct Shield<'a> {
    pub token: &'a AccountId,
    pub amount: U128,
    pub commitment: FieldStr,
    pub leaf_index: U64,
    pub root: FieldStr,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ShieldRefused<'a> {
    pub token: &'a AccountId,
    pub sender: &'a AccountId,
    pub amount: U128,
    pub reason: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Transact<'a> {
    pub nullifiers: [FieldStr; 2],
    pub commitments: [FieldStr; 2],
    pub leaf_index: U64,
    pub root: FieldStr,
    pub public_amount: U128,
    pub token: Option<&'a AccountId>,
    pub recipient: Option<&'a AccountId>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Swap {
    pub deal_id: U64,
    pub nullifiers: [FieldStr; 4],
    pub commitments: [FieldStr; 4],
    pub leaf_index: U64,
    pub root: FieldStr,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Payout<'a> {
    pub token: &'a AccountId,
    pub to: &'a AccountId,
    pub amount: U128,
    /// "paid", "refunded" (a refund note went back into the pool) or "held" (claimable).
    pub outcome: &'a str,
    pub refund_commitment: Option<FieldStr>,
    pub leaf_index: Option<U64>,
    pub root: Option<FieldStr>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RuleChange<'a, T: Serialize> {
    pub id: U64,
    pub status: &'a str,
    pub apply_after_ns: U64,
    pub change: &'a T,
}

pub fn shield(e: Shield) {
    emit("shield", e)
}
pub fn shield_refused(e: ShieldRefused) {
    emit("shield_refused", e)
}
pub fn transact(e: Transact) {
    emit("transact", e)
}
pub fn swap(e: Swap) {
    emit("swap", e)
}
pub fn payout(e: Payout) {
    emit("payout", e)
}
pub fn rule_change<T: Serialize>(e: RuleChange<T>) {
    emit("rule_change", e)
}
pub fn deposits_paused(paused: bool) {
    emit("deposits_paused", json!({ "paused": paused }))
}
