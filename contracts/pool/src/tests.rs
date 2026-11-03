//! Unit tests against real Groth16 proofs (tests/fixtures.json, made with the dev
//! keys by circuits/scripts/gen-fixtures.mjs). The mocked VM runs the real alt_bn128
//! host functions, so the verifier here is the one that runs on chain.
//!
//! The fixture is one scenario; `replay` applies it step by step in order.

use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, Gas, NearToken};

const FIXTURE: &str = include_str!("../tests/fixtures.json");

fn fx() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

fn s(v: &Value) -> String {
    v.as_str().unwrap().to_string()
}

fn field(v: &Value) -> FieldStr {
    FieldStr(field::parse(&s(v)).unwrap())
}

fn proof(v: &Value) -> Proof {
    serde_json::from_value(v["proof"].clone()).unwrap()
}

fn ctx(predecessor: &str, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("pool.test".parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(300))
        .block_height(100);
    testing_env!(b.build());
}

fn limits() -> Limits {
    Limits { per_deposit: U128(1_000_000), total: U128(10_000_000) }
}

fn new_pool() -> Pool {
    ctx("owner.test", NearToken::from_yoctonear(0));
    let f = fx();
    Pool::new(
        "owner.test".parse().unwrap(),
        Some("desk.test".parse().unwrap()),
        U64(1_000),
        vec![
            AssetInit { token: s(&f["tokens"]["usdc"]).parse().unwrap(), limits: limits() },
            AssetInit { token: s(&f["tokens"]["btc"]).parse().unwrap(), limits: limits() },
        ],
    )
}

fn shield(pool: &mut Pool, step: &Value) -> U128 {
    ctx(&s(&step["token"]), NearToken::from_yoctonear(0));
    let msg = format!("{{\"inner\":\"{}\"}}", s(&step["inner"]));
    match pool.ft_on_transfer(accounts(0), U128(s(&step["amount"]).parse().unwrap()), msg) {
        PromiseOrValue::Value(v) => v,
        _ => panic!("shield returned a promise"),
    }
}

fn transact_args(step: &Value, public_amount: u128, token: Option<&str>, ext: ExtData) -> TransactArgs {
    TransactArgs {
        root: field(&step["root"]),
        nullifiers: [field(&step["nullifiers"][0]), field(&step["nullifiers"][1])],
        commitments: [field(&step["commitments"][0]), field(&step["commitments"][1])],
        public_amount: U128(public_amount),
        token: token.map(|t| t.parse().unwrap()),
        ext,
    }
}

fn cash_out_ext(f: &Value) -> ExtData {
    let e = &f["cashOut"]["ext"];
    ExtData {
        recipient: Some(s(&e["recipient"]).parse().unwrap()),
        relayer: Some(s(&e["relayer"]).parse().unwrap()),
        fee: U128(1),
        refund_inner: Some(field(&e["refund_inner"])),
        memo: None,
    }
}

fn leg(v: &Value) -> SwapLeg {
    SwapLeg {
        proof: proof(v),
        root: field(&v["root"]),
        nullifiers: [field(&v["nullifiers"][0]), field(&v["nullifiers"][1])],
        commitments: [field(&v["commitments"][0]), field(&v["commitments"][1])],
    }
}

const STORAGE: NearToken = NearToken::from_millinear(50);

/// Applies the scenario up to and including `upto` steps: 1 shield, 2 send, 3 cash out, 4 shield, 5 swap.
fn replay(upto: u8) -> (Pool, Value) {
    let f = fx();
    let mut pool = new_pool();
    if upto >= 1 {
        assert_eq!(shield(&mut pool, &f["shieldAlice"]).0, 0);
    }
    if upto >= 2 {
        ctx("relayer.test", STORAGE);
        let _ = pool.transact(proof(&f["send"]), transact_args(&f["send"], 0, None, ExtData::default()));
    }
    if upto >= 3 {
        ctx("relayer.test", STORAGE);
        let usdc = s(&f["tokens"]["usdc"]);
        let _ = pool.transact(proof(&f["cashOut"]), transact_args(&f["cashOut"], 30, Some(&usdc), cash_out_ext(&f)));
    }
    if upto >= 4 {
        assert_eq!(shield(&mut pool, &f["shieldMaker"]).0, 0);
    }
    if upto >= 5 {
        ctx("desk.test", STORAGE);
        pool.settle_swap(U64(7), [leg(&f["swap"]["legA"]), leg(&f["swap"]["legB"])]);
    }
    (pool, f)
}

#[test]
fn asset_fields_match_the_sdk() {
    let f = fx();
    assert_eq!(field::asset_field(&s(&f["tokens"]["usdc"])), field(&f["assetFields"]["usdc"]).0);
    assert_eq!(field::asset_field(&s(&f["tokens"]["btc"])), field(&f["assetFields"]["btc"]).0);
}

#[test]
fn shield_computes_the_commitment_and_root() {
    let (pool, f) = replay(1);
    assert_eq!(pool.next_leaf_index().0, 1);
    assert_eq!(pool.get_root(), field(&f["send"]["root"]));
    assert_eq!(pool.assets().iter().find(|a| a.token.as_str() == "usdc.test").unwrap().held.0, 100);
}

#[test]
fn private_send_verifies_and_inserts() {
    let (pool, f) = replay(2);
    assert_eq!(pool.next_leaf_index().0, 3);
    assert!(pool.is_spent(field(&f["send"]["nullifiers"][0])));
    let spend = pool.spend_of(field(&f["send"]["nullifiers"][0])).unwrap();
    assert_eq!(spend.outputs[0], field(&f["send"]["commitments"][0]));
    assert!(spend.deal_id.is_none());
    assert_eq!(pool.get_root(), field(&f["cashOut"]["root"]));
}

#[test]
fn cash_out_verifies_and_reduces_holdings() {
    let (pool, _) = replay(3);
    assert_eq!(pool.next_leaf_index().0, 5);
    assert_eq!(pool.assets().iter().find(|a| a.token.as_str() == "usdc.test").unwrap().held.0, 70);
    assert_eq!(pool.stats().cash_outs, 1);
}

#[test]
fn swap_settles_both_legs_in_one_call() {
    let (pool, f) = replay(5);
    assert_eq!(pool.next_leaf_index().0, 10);
    assert_eq!(pool.get_root(), field(&f["rootAfterAll"]));
    let spend = pool.spend_of(field(&f["swap"]["legB"]["nullifiers"][0])).unwrap();
    assert_eq!(spend.deal_id, Some(U64(7)));
    assert_eq!(pool.stats().swaps, 1);
}

#[test]
#[should_panic(expected = "A note is already spent")]
fn double_spend_is_refused() {
    let (mut pool, f) = replay(2);
    ctx("relayer.test", STORAGE);
    let _ = pool.transact(proof(&f["send"]), transact_args(&f["send"], 0, None, ExtData::default()));
}

#[test]
#[should_panic(expected = "Invalid proof")]
fn a_relayer_cannot_redirect_a_cash_out() {
    let (mut pool, f) = replay(2);
    ctx("relayer.test", STORAGE);
    let usdc = s(&f["tokens"]["usdc"]);
    let mut ext = cash_out_ext(&f);
    ext.recipient = Some("mallory.test".parse().unwrap());
    let _ = pool.transact(proof(&f["cashOut"]), transact_args(&f["cashOut"], 30, Some(&usdc), ext));
}

#[test]
#[should_panic(expected = "Invalid proof")]
fn a_cash_out_cannot_claim_more() {
    let (mut pool, f) = replay(2);
    ctx("relayer.test", STORAGE);
    let usdc = s(&f["tokens"]["usdc"]);
    let _ = pool.transact(proof(&f["cashOut"]), transact_args(&f["cashOut"], 31, Some(&usdc), cash_out_ext(&f)));
}

#[test]
#[should_panic(expected = "Invalid proof")]
fn a_tampered_output_is_refused() {
    let (mut pool, f) = replay(1);
    ctx("relayer.test", STORAGE);
    let mut args = transact_args(&f["send"], 0, None, ExtData::default());
    args.commitments[0] = field(&f["cashOut"]["commitments"][0]);
    let _ = pool.transact(proof(&f["send"]), args);
}

#[test]
#[should_panic(expected = "Unknown root")]
fn an_unknown_root_is_refused() {
    let (mut pool, f) = replay(1);
    ctx("relayer.test", STORAGE);
    let mut args = transact_args(&f["send"], 0, None, ExtData::default());
    args.root = FieldStr(field::from_u128(12345));
    let _ = pool.transact(proof(&f["send"]), args);
}

#[test]
#[should_panic(expected = "Only the desk settles swaps")]
fn only_the_desk_settles() {
    let (mut pool, f) = replay(4);
    ctx("relayer.test", STORAGE);
    pool.settle_swap(U64(7), [leg(&f["swap"]["legA"]), leg(&f["swap"]["legB"])]);
}

#[test]
#[should_panic(expected = "Invalid proof")]
fn a_leg_bound_to_another_deal_is_refused() {
    let (mut pool, f) = replay(4);
    ctx("desk.test", STORAGE);
    pool.settle_swap(U64(8), [leg(&f["swap"]["legA"]), leg(&f["swap"]["legB"])]);
}

#[test]
#[should_panic(expected = "Invalid proof")]
fn legs_cannot_be_mixed() {
    let (mut pool, f) = replay(4);
    ctx("desk.test", STORAGE);
    // leg A with the send proof's leg in place of the maker's: bindings differ
    let mut b = leg(&f["swap"]["legB"]);
    b.proof = proof(&f["swap"]["legA"]);
    pool.settle_swap(U64(7), [leg(&f["swap"]["legA"]), b]);
}

#[test]
#[should_panic(expected = "Attach at least")]
fn storage_must_be_paid() {
    let (mut pool, f) = replay(1);
    ctx("relayer.test", NearToken::from_yoctonear(0));
    let _ = pool.transact(proof(&f["send"]), transact_args(&f["send"], 0, None, ExtData::default()));
}

#[test]
fn deposits_above_limits_or_unlisted_are_returned() {
    let mut pool = new_pool();
    ctx("usdc.test", NearToken::from_yoctonear(0));
    let back = pool.ft_on_transfer(accounts(0), U128(2_000_000), "{\"inner\":\"5\"}".into());
    assert!(matches!(back, PromiseOrValue::Value(U128(2_000_000))));
    ctx("other.test", NearToken::from_yoctonear(0));
    let back = pool.ft_on_transfer(accounts(0), U128(10), "{\"inner\":\"5\"}".into());
    assert!(matches!(back, PromiseOrValue::Value(U128(10))));
    ctx("usdc.test", NearToken::from_yoctonear(0));
    let back = pool.ft_on_transfer(accounts(0), U128(10), "not json".into());
    assert!(matches!(back, PromiseOrValue::Value(U128(10))));
    assert_eq!(pool.next_leaf_index().0, 0);
}

#[test]
fn paused_deposits_are_returned_but_sends_work() {
    let (mut pool, f) = replay(1);
    ctx("owner.test", NearToken::from_yoctonear(0));
    pool.set_deposits_paused(true);
    let back = shield(&mut pool, &f["shieldMaker"]);
    assert_eq!(back.0, 5);
    ctx("relayer.test", STORAGE);
    let _ = pool.transact(proof(&f["send"]), transact_args(&f["send"], 0, None, ExtData::default()));
}

#[test]
fn receipt_proof_checks_against_the_swap() {
    let (pool, f) = replay(5);
    let r = &f["receipt"];
    let inputs: Vec<FieldStr> = r["publicSignals"].as_array().unwrap().iter().map(field).collect();
    let check = pool.verify_disclosure("receipt".into(), proof(r), inputs, None);
    assert!(check.proof_valid && check.chain_valid, "{:?}", check.problems);
    assert_eq!(check.deal_ids, vec![Some(U64(7))]);
    assert_eq!(check.token.unwrap().as_str(), "usdc.test");
}

#[test]
fn receipt_proof_before_settlement_is_not_on_chain() {
    let (pool, f) = replay(4);
    let r = &f["receipt"];
    let inputs: Vec<FieldStr> = r["publicSignals"].as_array().unwrap().iter().map(field).collect();
    let check = pool.verify_disclosure("receipt".into(), proof(r), inputs, None);
    assert!(check.proof_valid && !check.chain_valid);
}

#[test]
fn funds_and_volume_proofs_check() {
    let (pool, f) = replay(5);
    let fu = &f["funds"];
    let inputs: Vec<FieldStr> = fu["publicSignals"].as_array().unwrap().iter().map(field).collect();
    let check = pool.verify_disclosure("funds".into(), proof(fu), inputs, None);
    assert!(check.proof_valid && check.chain_valid, "{:?}", check.problems);

    let v = &f["volume"];
    let inputs: Vec<FieldStr> = v["publicSignals"].as_array().unwrap().iter().map(field).collect();
    let legs: Vec<[FieldStr; 2]> = v["legs"].as_array().unwrap().iter().map(|l| [field(&l[0]), field(&l[1])]).collect();
    let check = pool.verify_disclosure("volume".into(), proof(v), inputs.clone(), Some(legs));
    assert!(check.proof_valid && check.chain_valid, "{:?}", check.problems);
    assert_eq!(check.deal_ids, vec![Some(U64(7))]);

    // a tampered public input fails the proof
    let mut bad = inputs;
    bad[1] = FieldStr(field::from_u128(3));
    assert!(!pool.verify_disclosure("volume".into(), proof(v), bad, None).proof_valid);
}

#[test]
fn rule_changes_wait_for_the_timelock() {
    let mut pool = new_pool();
    ctx("owner.test", NearToken::from_yoctonear(0));
    let id = pool.propose_change(Change::SetDesk { desk: "desk2.test".parse().unwrap() });
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id("anyone.test".parse().unwrap()).block_timestamp(10_000);
    testing_env!(b.build());
    pool.apply_change(id);
    assert_eq!(pool.config()["desk"], "desk2.test");
}

#[test]
#[should_panic(expected = "The timelock has not passed")]
fn rule_changes_cannot_skip_the_timelock() {
    let mut pool = new_pool();
    ctx("owner.test", NearToken::from_yoctonear(0));
    let id = pool.propose_change(Change::SetDesk { desk: "desk2.test".parse().unwrap() });
    pool.apply_change(id);
}
