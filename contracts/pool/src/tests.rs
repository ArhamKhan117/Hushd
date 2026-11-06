//! Unit tests against real Groth16 proofs (tests/fixtures.json, made with the dev
//! keys by circuits/scripts/gen-fixtures.mjs). The mocked VM runs the real alt_bn128
//! host functions, so the verifier here is the one that runs on chain.
//!
//! The fixture is one scenario; `replay` applies it step by step in order.

use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, Gas, NearToken, PromiseResult, RuntimeFeesConfig};

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

fn builder(predecessor: &str, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id("pool.test".parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(300))
        .block_height(100);
    b
}

fn ctx(predecessor: &str, deposit: NearToken) {
    testing_env!(builder(predecessor, deposit).build());
}

/// A callback context with these promise results.
fn with_results(predecessor: &str, results: Vec<PromiseResult>) {
    let b = builder(predecessor, NearToken::from_yoctonear(0));
    testing_env!(b.build(), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

fn limits() -> Limits {
    Limits { per_deposit: U128(1_000_000), total: U128(10_000_000), min_deposit: U128(0) }
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
    assert_eq!(pool.assets().iter().find(|a| a.token.as_str() == "usdc.sandbox").unwrap().held.0, 100);
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
    assert_eq!(pool.assets().iter().find(|a| a.token.as_str() == "usdc.sandbox").unwrap().held.0, 70);
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
    ctx("usdc.sandbox", NearToken::from_yoctonear(0));
    let back = pool.ft_on_transfer(accounts(0), U128(2_000_000), "{\"inner\":\"5\"}".into());
    assert!(matches!(back, PromiseOrValue::Value(U128(2_000_000))));
    ctx("other.test", NearToken::from_yoctonear(0));
    let back = pool.ft_on_transfer(accounts(0), U128(10), "{\"inner\":\"5\"}".into());
    assert!(matches!(back, PromiseOrValue::Value(U128(10))));
    ctx("usdc.sandbox", NearToken::from_yoctonear(0));
    let back = pool.ft_on_transfer(accounts(0), U128(10), "not json".into());
    assert!(matches!(back, PromiseOrValue::Value(U128(10))));
    assert_eq!(pool.next_leaf_index().0, 0);
}

#[test]
fn paused_deposits_are_returned_but_sends_work() {
    let (mut pool, f) = replay(1);
    ctx("owner.test", ONE_YOCTO);
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
    assert_eq!(check.token.unwrap().as_str(), "usdc.sandbox");
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
    ctx("owner.test", ONE_YOCTO);
    let id = pool.propose_change(Change::SetDesk { desk: "desk2.test".parse().unwrap() });
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id("anyone.test".parse().unwrap()).attached_deposit(ONE_YOCTO).block_timestamp(10_000);
    testing_env!(b.build());
    pool.apply_change(id);
    assert_eq!(pool.config()["desk"], "desk2.test");
}

#[test]
#[should_panic(expected = "The timelock has not passed")]
fn rule_changes_cannot_skip_the_timelock() {
    let mut pool = new_pool();
    ctx("owner.test", ONE_YOCTO);
    let id = pool.propose_change(Change::SetDesk { desk: "desk2.test".parse().unwrap() });
    pool.apply_change(id);
}

#[test]
fn every_leaf_is_readable_in_order() {
    let (pool, f) = replay(5);
    let leaves = pool.leaves(U64(0), 100);
    assert_eq!(leaves.len(), 10);
    assert_eq!(leaves[0], field(&f["shieldAlice"]["commitment"]));
    assert_eq!(leaves[1], field(&f["send"]["commitments"][0]));
    assert_eq!(leaves[5], field(&f["shieldMaker"]["commitment"]));
    assert_eq!(leaves[9], field(&f["swap"]["legB"]["commitments"][1]));
    assert_eq!(pool.leaves(U64(8), 100).len(), 2);
    assert!(pool.leaves(U64(50), 10).is_empty());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn rule_changes_take_one_yocto() {
    let mut pool = new_pool();
    ctx("owner.test", NearToken::from_yoctonear(0));
    pool.propose_change(Change::SetDesk { desk: "desk2.test".parse().unwrap() });
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn pausing_takes_one_yocto() {
    let mut pool = new_pool();
    ctx("owner.test", NearToken::from_yoctonear(0));
    pool.set_deposits_paused(true);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn a_claim_takes_one_yocto() {
    let mut pool = new_pool();
    ctx("alice.test", NearToken::from_yoctonear(0));
    let _ = pool.claim("usdc.sandbox".parse().unwrap());
}

#[test]
#[should_panic(expected = "refund_inner must not be zero")]
fn a_zero_refund_inner_is_refused() {
    let (mut pool, f) = replay(2);
    ctx("relayer.test", STORAGE);
    let usdc = s(&f["tokens"]["usdc"]);
    let mut ext = cash_out_ext(&f);
    // None and Some(0) hash alike: without this check a relayer could drop the refund note
    ext.refund_inner = Some(FieldStr(ZERO));
    let _ = pool.transact(proof(&f["cashOut"]), transact_args(&f["cashOut"], 30, Some(&usdc), ext));
}

#[test]
#[should_panic(expected = "The two outputs are the same note")]
fn equal_outputs_in_one_transact_are_refused() {
    let (mut pool, f) = replay(1);
    ctx("relayer.test", STORAGE);
    let mut args = transact_args(&f["send"], 0, None, ExtData::default());
    args.commitments[1] = args.commitments[0];
    let _ = pool.transact(proof(&f["send"]), args);
}

#[test]
#[should_panic(expected = "Two outputs are the same note")]
fn equal_outputs_in_one_swap_are_refused() {
    let (mut pool, f) = replay(4);
    ctx("desk.test", STORAGE);
    let a = leg(&f["swap"]["legA"]);
    let mut b = leg(&f["swap"]["legB"]);
    b.commitments[0] = a.commitments[1];
    pool.settle_swap(U64(7), [a, b]);
}

#[test]
#[should_panic(expected = "This note already exists in the pool")]
fn a_commitment_already_in_the_tree_is_refused() {
    let (mut pool, f) = replay(1);
    // as if the send's payment note had been inserted before (a shield or an earlier move)
    pool.commitments.insert(field(&f["send"]["commitments"][0]).0);
    ctx("relayer.test", STORAGE);
    let _ = pool.transact(proof(&f["send"]), transact_args(&f["send"], 0, None, ExtData::default()));
}

#[test]
fn a_shield_of_an_existing_note_is_returned() {
    let (mut pool, f) = replay(1);
    let back = shield(&mut pool, &f["shieldAlice"]);
    assert_eq!(back.0, 100, "the same inner and amount again: the tokens go back");
    assert!(get_logs().iter().any(|l| l.contains("shield_refused") && l.contains("already exists")));
    assert_eq!(pool.next_leaf_index().0, 1);
    assert_eq!(pool.assets().iter().find(|a| a.token.as_str() == "usdc.sandbox").unwrap().held.0, 100);
}

#[test]
fn a_refund_note_that_already_exists_is_held_instead() {
    let (mut pool, f) = replay(1);
    let usdc: AccountId = s(&f["tokens"]["usdc"]).parse().unwrap();
    // the refund note for 100 to alice's shield inner is her shield note itself
    let inner = field(&f["shieldAlice"]["inner"]);
    with_results("pool.test", vec![PromiseResult::Failed]);
    pool.on_payout(usdc.clone(), "alice.test".parse().unwrap(), U128(100), None, U128(0), Some(inner));
    assert_eq!(pool.next_leaf_index().0, 1, "no second leaf with the same commitment");
    assert_eq!(pool.unclaimed("alice.test".parse().unwrap(), usdc).0, 100);
}

#[test]
fn shields_below_the_minimum_are_returned() {
    ctx("owner.test", NearToken::from_yoctonear(0));
    let f = fx();
    let usdc = s(&f["tokens"]["usdc"]);
    let mut pool = Pool::new(
        "owner.test".parse().unwrap(),
        None,
        U64(1_000),
        vec![AssetInit { token: usdc.parse().unwrap(), limits: Limits { min_deposit: U128(1_000), ..limits() } }],
    );
    ctx(&usdc, NearToken::from_yoctonear(0));
    let back = pool.ft_on_transfer(accounts(0), U128(999), "{\"inner\":\"5\"}".into());
    assert!(matches!(back, PromiseOrValue::Value(U128(999))));
    assert!(get_logs().iter().any(|l| l.contains("Below the minimum deposit")));
    let back = pool.ft_on_transfer(accounts(0), U128(1_000), "{\"inner\":\"5\"}".into());
    assert!(matches!(back, PromiseOrValue::Value(U128(0))));
    assert_eq!(pool.next_leaf_index().0, 1);
}

#[test]
fn limits_without_a_minimum_still_parse() {
    let l: Limits = serde_json::from_str(r#"{"per_deposit":"10","total":"100"}"#).unwrap();
    assert_eq!(l.min_deposit, U128(0));
}

#[test]
#[should_panic(expected = "min_deposit <= per_deposit <= total")]
fn a_minimum_above_the_per_deposit_limit_is_refused() {
    ctx("owner.test", NearToken::from_yoctonear(0));
    Pool::new(
        "owner.test".parse().unwrap(),
        None,
        U64(1_000),
        vec![AssetInit { token: "usdc.test".parse().unwrap(), limits: Limits { min_deposit: U128(2_000_000), ..limits() } }],
    );
}

#[test]
fn a_payout_that_returns_a_long_value_still_counts_as_paid() {
    let (mut pool, f) = replay(1);
    let usdc: AccountId = s(&f["tokens"]["usdc"]).parse().unwrap();
    with_results("pool.test", vec![PromiseResult::Successful(vec![b'1'; 200])]);
    pool.on_payout(usdc, "alice.test".parse().unwrap(), U128(29), None, U128(0), Some(field(&f["shieldAlice"]["inner"])));
    assert!(get_logs().iter().any(|l| l.contains("\"outcome\":\"paid\"")), "{:?}", get_logs());
    assert_eq!(pool.stats().refunds, 0);
    assert_eq!(pool.next_leaf_index().0, 1);
}

/// The receipt proves the note in deal 7's leg A slot 0 (Bob's payment to the maker).
/// Had that note been the leg's change (slot 1), the same proof must not pass.
#[test]
fn a_receipt_only_counts_the_payment_slot() {
    let (mut pool, f) = replay(5);
    let r = &f["receipt"];
    let inputs: Vec<FieldStr> = r["publicSignals"].as_array().unwrap().iter().map(field).collect();
    let nullifier = field(&f["swap"]["legA"]["nullifiers"][0]).0;
    let spend = pool.spends.get_mut(&nullifier).unwrap();
    spend.outputs.swap(0, 1);
    let check = pool.verify_disclosure("receipt".into(), proof(r), inputs, None);
    assert!(check.proof_valid && !check.chain_valid);
    assert_eq!(check.problems, vec!["The proven note is the payer's change, not the payment".to_string()]);
    assert!(check.deal_ids.is_empty());
}

#[test]
fn a_volume_leg_only_counts_the_payment_slot() {
    let (mut pool, f) = replay(5);
    let v = &f["volume"];
    let inputs: Vec<FieldStr> = v["publicSignals"].as_array().unwrap().iter().map(field).collect();
    let legs: Vec<[FieldStr; 2]> = v["legs"].as_array().unwrap().iter().map(|l| [field(&l[0]), field(&l[1])]).collect();
    let spend = pool.spends.get_mut(&legs[0][1].0).unwrap();
    spend.outputs.swap(0, 1);
    let check = pool.verify_disclosure("volume".into(), proof(v), inputs, Some(legs));
    assert!(check.proof_valid && !check.chain_valid);
    assert!(check.problems.iter().any(|p| p.contains("own change")), "{:?}", check.problems);
}

#[test]
fn a_volume_check_with_too_many_legs_stops_early() {
    let (pool, f) = replay(5);
    let v = &f["volume"];
    let inputs: Vec<FieldStr> = v["publicSignals"].as_array().unwrap().iter().map(field).collect();
    let many: Vec<[FieldStr; 2]> = (0..1_000u128).map(|i| [FieldStr(field::from_u128(i)), FieldStr(field::from_u128(i))]).collect();
    let check = pool.verify_disclosure("volume".into(), proof(v), inputs, Some(many));
    assert!(check.proof_valid && !check.chain_valid);
    assert_eq!(check.problems, vec!["A volume proof covers at most 16 legs".to_string()]);
}

#[test]
fn leaves_past_the_end_are_empty() {
    let (pool, _) = replay(1);
    assert!(pool.leaves(U64(u64::MAX), 1_000).is_empty());
}
