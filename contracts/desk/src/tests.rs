use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const T0: u64 = 1_800_000_000_000; // ms
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const DAY_NS: u64 = 86_400_000_000_000;

fn desk_id() -> AccountId {
    "desk.test".parse().unwrap()
}

fn enclave() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn quote_signer() -> SigningKey {
    SigningKey::from_bytes(&[5u8; 32])
}

fn ed_key(k: &SigningKey) -> String {
    format!("ed25519:{}", near_sdk::bs58::encode(k.verifying_key().to_bytes()).into_string())
}

fn ctx(predecessor: &str, deposit: NearToken, ms: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id("desk.test".parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .attached_deposit(deposit)
        .block_timestamp(ms * 1_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    b
}

fn set(b: VMContextBuilder) {
    testing_env!(b.build());
}

fn with_result(b: VMContextBuilder, result: PromiseResult) {
    testing_env!(b.build(), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

fn config() -> Config {
    Config {
        owner: "owner.test".parse().unwrap(),
        pool: "pool.test".parse().unwrap(),
        bond_token: "usdc.test".parse().unwrap(),
        outlayer: "outlayer.test".parse().unwrap(),
        matcher_project: "hushd.test/matcher".into(),
        secrets_owner: "hushd.test".parse().unwrap(),
        mpc: "signer.test".parse().unwrap(),
        keeper: "keeper.test".parse().unwrap(),
        outlayer_fee: U128(10_000_000_000_000_000_000_000),
        min_bond: U128(1_000_000),
        config_timelock_ns: U64(DAY_NS),
    }
}

/// A desk with the enclave key installed through the OutLayer callback, a maker
/// with 100 USDC of bond and one open RFQ (id 0).
fn desk() -> Desk {
    set(ctx("owner.test", NearToken::from_yoctonear(0), T0));
    let mut d = Desk::new(config());
    let out = json!({ "success": true, "result": {
        "sign_key": format!("0x{}", hex::encode(enclave().verifying_key().to_bytes())),
        "enc_key": format!("0x{}", "ab".repeat(32)),
    }})
    .to_string();
    with_result(ctx("desk.test", NearToken::from_yoctonear(0), T0), PromiseResult::Successful(serde_json::to_vec(&out).unwrap()));
    // the live OutLayer resumes with the worker's JSON as an object
    d.on_enclave_key(Ok(serde_json::from_str(&out).unwrap()));
    set(ctx("maker.test", NearToken::from_millinear(20), T0));
    d.register_maker("Maker".into(), format!("0x{}", "cd".repeat(32)), "https://maker.test/quote".into(), "fixed".into(), ed_key(&quote_signer()));
    set(ctx("usdc.test", NearToken::from_yoctonear(0), T0));
    assert!(matches!(d.ft_on_transfer("maker.test".parse().unwrap(), U128(100_000_000), "bond".into()), PromiseOrValue::Value(U128(0))));
    set(ctx("relayer.test", NearToken::from_millinear(20), T0));
    d.open_rfq(format!("0x{}", "11".repeat(32)), U64(30_000));
    d
}

fn hedge_spec() -> HedgeSpec {
    HedgeSpec { asset: 4, coin: "NEAR".into(), is_buy: false, size: "100".into(), limit_px: "2.1".into(), deadline_ms: T0 + 600_000, testnet: true }
}

/// The maker's quote key signs consent v2 over the match as it stands.
fn maker_signs(m: &mut MatchResult) {
    m.maker_sig = Base64VecU8(quote_signer().sign(&m.consent_bytes(&desk_id()).unwrap()).to_bytes().to_vec());
}

fn owner_key() -> SigningKey {
    SigningKey::from_bytes(&[9u8; 32])
}

fn matched(class: SettlementClass, bond: u128) -> MatchResult {
    let mut m = MatchResult {
        rfq_id: U64(0),
        maker: "maker.test".parse().unwrap(),
        terms_hash: format!("0x{}", hex::encode([0x22u8; 32])),
        class,
        expires_at_ms: U64(T0 + 300_000),
        bond: U128(bond),
        trader_inner: Some(format!("0x00{}", "33".repeat(31))),
        owner_key: Some(ed_key(&owner_key())),
        hedge: (class == SettlementClass::BondedHedge).then(hedge_spec),
        maker_sig: Base64VecU8(vec![]),
    };
    maker_signs(&mut m);
    m
}

fn sign(m: &MatchResult) -> Base64VecU8 {
    Base64VecU8(enclave().sign(&m.signing_bytes(&desk_id())).to_bytes().to_vec())
}

/// The match through the OutLayer callback; the deal id or the reason it was refused.
fn via_outlayer(d: &mut Desk, m: &MatchResult, ms: u64) -> Result<U64, String> {
    let out = json!({ "success": true, "result": { "matched": true, "match": m } }).to_string();
    set(ctx("desk.test", NearToken::from_yoctonear(0), ms));
    d.on_match(U64(0), Ok(serde_json::Value::String(out))).ok_or_else(|| get_logs().join("\n"))
}

fn maker(d: &Desk) -> Maker {
    d.maker("maker.test".parse().unwrap()).unwrap()
}

fn submit(d: &mut Desk, m: MatchResult) -> U64 {
    set(ctx("relayer.test", NearToken::from_millinear(10), T0 + 1_000));
    let s = sign(&m);
    d.submit_match(m, s)
}

#[test]
fn makers_post_and_withdraw_bond() {
    let mut d = desk();
    assert_eq!(d.maker("maker.test".parse().unwrap()).unwrap().bond.0, 100_000_000);
    set(ctx("maker.test", ONE_YOCTO, T0));
    let _ = d.withdraw_bond(U128(40_000_000));
    assert_eq!(d.maker("maker.test".parse().unwrap()).unwrap().bond.0, 60_000_000);
    // a failed transfer puts it back
    with_result(ctx("desk.test", NearToken::from_yoctonear(0), T0), PromiseResult::Failed);
    d.on_bond_withdrawn("maker.test".parse().unwrap(), U128(40_000_000));
    assert_eq!(d.maker("maker.test".parse().unwrap()).unwrap().bond.0, 100_000_000);
}

#[test]
fn bonds_from_strangers_or_other_tokens_go_back() {
    let mut d = desk();
    set(ctx("usdc.test", NearToken::from_yoctonear(0), T0));
    assert!(matches!(d.ft_on_transfer("nobody.test".parse().unwrap(), U128(5), "bond".into()), PromiseOrValue::Value(U128(5))));
    set(ctx("btc.test", NearToken::from_yoctonear(0), T0));
    assert!(matches!(d.ft_on_transfer("maker.test".parse().unwrap(), U128(5), "bond".into()), PromiseOrValue::Value(U128(5))));
}

#[test]
fn a_signed_match_creates_a_deal_and_locks_bond() {
    let mut d = desk();
    let id = submit(&mut d, matched(SettlementClass::BondedHedge, 10_000_000));
    let deal = d.deal(id).unwrap();
    assert_eq!(deal.status, DealStatus::Matched);
    assert_eq!(deal.attested_by, "enclave_signature");
    assert_eq!(d.maker("maker.test".parse().unwrap()).unwrap().locked.0, 10_000_000);
    assert!(!get_logs().iter().any(|l| l.contains("relayer.test")), "the submitter is never logged");
}

#[test]
#[should_panic(expected = "Not signed by the matcher enclave")]
fn an_unsigned_match_is_refused() {
    let mut d = desk();
    let m = matched(SettlementClass::AtomicPool, 0);
    let mut other = m.clone();
    other.terms_hash = format!("0x{}", "44".repeat(32));
    let s = sign(&other);
    set(ctx("relayer.test", NearToken::from_millinear(10), T0 + 1_000));
    d.submit_match(m, s);
}

#[test]
fn the_outlayer_callback_creates_a_deal() {
    let mut d = desk();
    let m = matched(SettlementClass::AtomicPool, 0);
    let out = json!({ "success": true, "result": { "matched": true, "match": m } }).to_string();
    with_result(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 1_000), PromiseResult::Successful(vec![]));
    let id = d.on_match(U64(0), Ok(serde_json::Value::String(out))).unwrap();
    assert_eq!(d.deal(id).unwrap().attested_by, "outlayer");
    assert_eq!(d.rfq(U64(0)).unwrap().deal_id, Some(id));
}

#[test]
fn a_failed_or_empty_enclave_run_makes_no_deal() {
    let mut d = desk();
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 1_000));
    assert!(d.on_match(U64(0), Err(PromiseError::Failed)).is_none());
    let none = json!({ "success": true, "result": { "matched": false, "reason": "no quote inside the limit" } }).to_string();
    assert!(d.on_match(U64(0), Ok(serde_json::Value::String(none))).is_none());
    assert_eq!(d.stats().deals, 0);
}

#[test]
fn a_match_beyond_free_bond_is_refused() {
    let mut d = desk();
    let m = matched(SettlementClass::BondedHedge, 200_000_000);
    let out = json!({ "success": true, "result": { "matched": true, "match": m } }).to_string();
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 1_000));
    assert!(d.on_match(U64(0), Ok(serde_json::Value::String(out))).is_none());
    assert!(get_logs().iter().any(|l| l.contains("free bond")));
}

#[test]
#[should_panic(expected = "already has a deal")]
fn one_deal_per_rfq() {
    let mut d = desk();
    submit(&mut d, matched(SettlementClass::AtomicPool, 0));
    submit(&mut d, matched(SettlementClass::AtomicPool, 0));
}

#[test]
fn an_atomic_deal_settles_with_a_receipt() {
    let mut d = desk();
    let id = submit(&mut d, matched(SettlementClass::AtomicPool, 0));
    set(ctx("relayer.test", NearToken::from_millinear(20), T0 + 2_000));
    let _ = d.settle(id, json!([{}, {}]));
    assert_eq!(d.deal(id).unwrap().status, DealStatus::Settling);
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 2_000));
    // a bad submission leaves the deal open
    assert!(!d.on_settled(id, Err(PromiseError::Failed)));
    assert_eq!(d.deal(id).unwrap().status, DealStatus::Matched);
    set(ctx("relayer.test", NearToken::from_millinear(20), T0 + 3_000));
    let _ = d.settle(id, json!([{}, {}]));
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 3_000));
    assert!(d.on_settled(id, Ok(json!({ "leaf_index": "6", "root": "0xab" }))));
    let deal = d.deal(id).unwrap();
    assert_eq!(deal.status, DealStatus::Closed);
    assert_eq!(deal.receipt.unwrap().outcome, Outcome::Settled);
    assert_eq!(d.stats().settled, 1);
}

#[test]
fn an_unsettled_deal_expires_as_failed() {
    let mut d = desk();
    let id = submit(&mut d, matched(SettlementClass::AtomicPool, 0));
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 400_000));
    d.expire(id);
    assert_eq!(d.deal(id).unwrap().receipt.unwrap().outcome, Outcome::Failed);
}

#[test]
#[should_panic(expected = "The deal has expired")]
fn an_expired_deal_cannot_settle() {
    let mut d = desk();
    let id = submit(&mut d, matched(SettlementClass::AtomicPool, 0));
    set(ctx("relayer.test", NearToken::from_millinear(20), T0 + 400_000));
    let _ = d.settle(id, json!([]));
}

fn hedge_pending(d: &mut Desk) -> U64 {
    let id = submit(d, matched(SettlementClass::BondedHedge, 10_000_000));
    set(ctx("relayer.test", NearToken::from_millinear(20), T0 + 2_000));
    let _ = d.settle(id, json!([{}, {}]));
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 2_000));
    d.on_settled(id, Ok(json!({ "leaf_index": "6", "root": "0xab" })));
    assert_eq!(d.deal(id).unwrap().status, DealStatus::HedgePending);
    id
}

#[test]
fn a_filled_hedge_closes_settled_and_frees_the_bond() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 3_000));
    let _ = d.sign_hedge_order(id);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 5_000));
    let _ = d.record_hedge(id, true, vec![Evidence { kind: "hyperliquid_fill".into(), reference: "oid 123 @ 2.11".into() }]);
    let deal = d.deal(id).unwrap();
    assert_eq!(deal.receipt.as_ref().unwrap().outcome, Outcome::Settled);
    assert_eq!(deal.receipt.unwrap().evidence.len(), 3);
    assert_eq!(d.maker("maker.test".parse().unwrap()).unwrap().locked.0, 0);
}

/// The keeper reports a miss for each of the three signed attempts; the last slashes.
fn missed_three_times(d: &mut Desk, id: U64) {
    for attempt in 1..=MAX_HEDGE_ATTEMPTS {
        set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 3_000));
        let _ = d.sign_hedge_order(id);
        assert_eq!(d.deal(id).unwrap().hedge_attempts, attempt);
        let _ = d.record_hedge(id, false, vec![Evidence { kind: "hyperliquid_reject".into(), reference: format!("attempt {attempt}") }]);
    }
}

/// The pool's answer to the slash payout: what ft_transfer_call says the pool kept.
fn slash_answer(d: &mut Desk, id: U64, amount: u128, result: PromiseResult) {
    with_result(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 5_000), result);
    d.on_slash_paid(id, U128(amount));
}

fn kept(amount: u128) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(&U128(amount)).unwrap())
}

#[test]
fn a_failed_hedge_slashes_the_bond_to_a_private_note() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    missed_three_times(&mut d, id);
    let m = maker(&d);
    assert_eq!((m.bond.0, m.locked.0, m.slashed.0), (90_000_000, 0, 10_000_000));
    let deal = d.deal(id).unwrap();
    assert_eq!(deal.status, DealStatus::Slashing);
    assert!(deal.bond_released);
    assert_eq!(deal.slash_held.0, 10_000_000);
    slash_answer(&mut d, id, 10_000_000, kept(10_000_000));
    let deal = d.deal(id).unwrap();
    assert_eq!(deal.status, DealStatus::Closed);
    assert_eq!(deal.slash_held.0, 0);
    let receipt = deal.receipt.unwrap();
    assert_eq!(receipt.outcome, Outcome::Recovered);
    assert_eq!(receipt.evidence.iter().filter(|e| e.kind == "hyperliquid_reject").count(), 3, "every attempt is on the receipt");
    assert_eq!(d.stats().slashed.0, 10_000_000);
}

#[test]
fn a_missed_hedge_before_the_deadline_can_be_signed_again() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 3_000));
    let _ = d.sign_hedge_order(id);
    let _ = d.record_hedge(id, false, vec![Evidence { kind: "hyperliquid_reject".into(), reference: "price moved".into() }]);
    let deal = d.deal(id).unwrap();
    assert_eq!((deal.status, deal.hedge_orders, deal.hedge_attempts), (DealStatus::HedgePending, 0, 1));
    assert_eq!(maker(&d).locked.0, 10_000_000, "no slash yet");
    // the maker may ask for the next attempt itself
    set(ctx("maker.test", NearToken::from_yoctonear(0), T0 + 4_000));
    let _ = d.sign_hedge_order(id);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 5_000));
    let _ = d.record_hedge(id, true, vec![Evidence { kind: "hyperliquid_fill".into(), reference: "oid 9".into() }]);
    let deal = d.deal(id).unwrap();
    assert_eq!((deal.status, deal.hedge_orders, deal.hedge_attempts), (DealStatus::Closed, 1, 2));
    assert_eq!(deal.receipt.unwrap().outcome, Outcome::Settled);
    assert_eq!(maker(&d).locked.0, 0);
}

#[test]
#[should_panic(expected = "No open hedge leg")]
fn no_fourth_attempt_once_slashed() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    missed_three_times(&mut d, id);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 6_000));
    let _ = d.record_hedge(id, false, vec![]);
}

#[test]
fn a_miss_past_the_deadline_slashes_at_once() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 3_000));
    let _ = d.sign_hedge_order(id);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 700_000));
    let _ = d.record_hedge(id, false, vec![]);
    assert_eq!(d.deal(id).unwrap().status, DealStatus::Slashing);
}

#[test]
fn an_overdue_hedge_can_be_slashed_by_anyone() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 700_000));
    let _ = d.slash_overdue(id);
    assert_eq!(maker(&d).slashed.0, 10_000_000);
    assert_eq!(d.deal(id).unwrap().status, DealStatus::Slashing);
}

#[test]
#[should_panic(expected = "No open hedge leg")]
fn a_bond_cannot_be_slashed_twice() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 700_000));
    let _ = d.slash_overdue(id);
    // the payout is in flight: a second slash must not take the bond again
    let _ = d.slash_overdue(id);
}

#[test]
#[should_panic(expected = "No open hedge leg")]
fn the_keeper_cannot_slash_a_deal_already_slashing() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 700_000));
    let _ = d.slash_overdue(id);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 700_000));
    let _ = d.record_hedge(id, false, vec![]);
}

#[test]
#[should_panic(expected = "The deal is not slashing")]
fn a_slash_payout_answer_needs_a_slash_in_flight() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    slash_answer(&mut d, id, 10_000_000, kept(10_000_000));
}

#[test]
fn a_refused_slash_payout_waits_for_a_retry() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 700_000));
    let _ = d.slash_overdue(id);
    // the pool refused the shield (deposits paused, say): the token sent everything back
    slash_answer(&mut d, id, 10_000_000, kept(0));
    let deal = d.deal(id).unwrap();
    assert_eq!(deal.status, DealStatus::SlashRefused);
    assert_eq!(deal.slash_held.0, 10_000_000);
    assert_eq!(deal.receipt.as_ref().unwrap().outcome, Outcome::Unresolved);
    let m = maker(&d);
    assert_eq!((m.bond.0, m.locked.0), (90_000_000, 0), "the held bond is no longer the maker's");
    assert_eq!(d.stats().slashed.0, 0);
    assert_eq!(d.stats().unresolved, 0, "not closed: it can still be paid");

    // a failed call is a refusal too, and the receipt does not grow with each one
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 800_000));
    let _ = d.retry_slash_payout(id);
    assert_eq!(d.deal(id).unwrap().status, DealStatus::Slashing);
    slash_answer(&mut d, id, 10_000_000, PromiseResult::Failed);
    let deal = d.deal(id).unwrap();
    assert_eq!(deal.status, DealStatus::SlashRefused);
    assert_eq!(deal.receipt.unwrap().evidence.iter().filter(|e| e.kind == "bond_payout_returned").count(), 1);

    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 900_000));
    let _ = d.retry_slash_payout(id);
    slash_answer(&mut d, id, 10_000_000, kept(10_000_000));
    let deal = d.deal(id).unwrap();
    assert_eq!(deal.status, DealStatus::Closed);
    assert_eq!(deal.slash_held.0, 0);
    let receipt = deal.receipt.unwrap();
    assert_eq!(receipt.outcome, Outcome::Recovered);
    assert!(receipt.evidence.iter().any(|e| e.kind == "bond_paid_privately"));
    assert_eq!(d.stats().slashed.0, 10_000_000);
    assert_eq!(maker(&d).slashed.0, 10_000_000);
}

#[test]
#[should_panic(expected = "No refused slash payout")]
fn only_a_refused_payout_is_retried() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 700_000));
    let _ = d.slash_overdue(id);
    let _ = d.retry_slash_payout(id);
}

#[test]
fn an_unreadable_slash_answer_counts_as_paid() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 700_000));
    let _ = d.slash_overdue(id);
    slash_answer(&mut d, id, 10_000_000, PromiseResult::Successful(vec![b'x'; 100]));
    assert_eq!(d.deal(id).unwrap().receipt.unwrap().outcome, Outcome::Recovered, "never sent twice");
}

#[test]
#[should_panic(expected = "already signed")]
fn one_opening_order_at_a_time() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 3_000));
    let _ = d.sign_hedge_order(id);
    let _ = d.sign_hedge_order(id);
}

#[test]
#[should_panic(expected = "Only the keeper or the deal's maker")]
fn strangers_cannot_sign_the_hedge_order() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 3_000));
    let _ = d.sign_hedge_order(id);
}

#[test]
fn a_failed_mpc_call_gives_the_attempt_back() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 3_000));
    let _ = d.sign_hedge_order(id);
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 3_000));
    assert!(d.on_hedge_signed(id, U64(T0 + 3_000), false, Err(PromiseError::Failed)).is_none());
    let deal = d.deal(id).unwrap();
    assert_eq!((deal.hedge_orders, deal.hedge_attempts), (0, 0));
}

#[test]
#[should_panic(expected = "Keeper only")]
fn only_the_keeper_records_fills() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 3_000));
    let _ = d.record_hedge(id, true, vec![]);
}

#[test]
fn only_the_trader_key_closes_the_hedge() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 3_000));
    let _ = d.sign_hedge_order(id);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 5_000));
    let _ = d.record_hedge(id, true, vec![]);
    let sig = owner_key().sign(format!("hushd.close:desk.test:{}", id.0).as_bytes()).to_bytes().to_vec();
    set(ctx("relayer.test", NearToken::from_yoctonear(0), T0 + 6_000));
    let _ = d.close_hedge(id, Base64VecU8(sig));
    assert_eq!(d.deal(id).unwrap().hedge_orders, 2);
}

#[test]
#[should_panic(expected = "Not signed by the deal's owner")]
fn a_close_signed_for_another_desk_is_refused() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 3_000));
    let _ = d.sign_hedge_order(id);
    let _ = d.record_hedge(id, true, vec![]);
    for msg in [format!("hushd.close:{}", id.0), format!("hushd.close:desk2.test:{}", id.0)] {
        let sig = owner_key().sign(msg.as_bytes()).to_bytes().to_vec();
        set(ctx("relayer.test", NearToken::from_yoctonear(0), T0 + 6_000));
        let _ = d.close_hedge(id, Base64VecU8(sig));
    }
}

#[test]
fn the_digest_view_matches_the_signed_order() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    assert_eq!(d.hedge_digest(id, U64(42), false), hex::encode(hedge::order_digest(&hedge_spec(), 42, false)));
    assert_eq!(d.hedge_path(id), "hushd/hedge/0");
}

#[test]
fn a_match_the_maker_did_not_sign_is_refused() {
    let mut d = desk();
    let mut m = matched(SettlementClass::AtomicPool, 0);
    m.maker_sig = Base64VecU8(SigningKey::from_bytes(&[6u8; 32]).sign(b"something else").to_bytes().to_vec());
    let out = json!({ "success": true, "result": { "matched": true, "match": m } }).to_string();
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 1_000));
    assert!(d.on_match(U64(0), Ok(serde_json::Value::String(out))).is_none());
    assert!(get_logs().iter().any(|l| l.contains("did not sign these terms")));
}

/// Consent v2 covers the class, the hedge, the maker and the desk: a matcher that changes
/// any of them after the maker signed is refused.
#[test]
fn a_match_that_changes_what_the_maker_signed_is_refused() {
    let signed = matched(SettlementClass::BondedHedge, 10_000_000);
    let mut other_hedge = signed.clone();
    other_hedge.hedge.as_mut().unwrap().size = "1000".into();
    let mut no_hedge = signed.clone();
    no_hedge.class = SettlementClass::AtomicPool;
    no_hedge.hedge = None;
    let mut other_deadline = signed.clone();
    other_deadline.hedge.as_mut().unwrap().deadline_ms += 1;
    let mut other_desk = signed.clone();
    other_desk.maker_sig = Base64VecU8(quote_signer().sign(&signed.consent_bytes(&"desk2.test".parse().unwrap()).unwrap()).to_bytes().to_vec());
    for m in [other_hedge, no_hedge, other_deadline, other_desk] {
        let mut d = desk();
        let why = via_outlayer(&mut d, &m, T0 + 1_000).unwrap_err();
        assert!(why.contains("did not sign these terms"), "{why}");
    }
    let mut d = desk();
    assert!(via_outlayer(&mut d, &signed, T0 + 1_000).is_ok());
}

#[test]
fn a_hedge_deadline_before_the_expiry_is_refused() {
    let mut d = desk();
    let mut m = matched(SettlementClass::BondedHedge, 10_000_000);
    m.hedge.as_mut().unwrap().deadline_ms = m.expires_at_ms.0;
    maker_signs(&mut m);
    let why = via_outlayer(&mut d, &m, T0 + 1_000).unwrap_err();
    assert!(why.contains("deadline must come after"), "{why}");
}

/// The pool takes only a nonzero field element below r, as 0x and 64 hex digits; anything
/// else would make the slash payout bounce, so the desk refuses the match up front.
#[test]
fn a_payout_note_the_pool_would_refuse_is_refused() {
    let r = "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001".to_string();
    let r_minus_1 = "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000".to_string();
    for (inner, ok) in [(r, false), (format!("0x{}", "00".repeat(32)), false), ("0x1234".into(), false), ("1234".into(), false), (format!("0x{}", "ff".repeat(32)), false), (r_minus_1, true)] {
        let mut d = desk();
        let mut m = matched(SettlementClass::BondedHedge, 10_000_000);
        m.trader_inner = Some(inner.clone());
        maker_signs(&mut m);
        let got = via_outlayer(&mut d, &m, T0 + 1_000);
        assert_eq!(got.is_ok(), ok, "{inner}: {got:?}");
        if !ok {
            assert!(got.unwrap_err().contains("payout note"));
        }
    }
}

#[test]
fn a_match_long_after_the_rfq_closed_is_refused() {
    // the RFQ closes at T0 + 30 s; a match is taken up to 15 minutes later
    let mut d = desk();
    let mut m = matched(SettlementClass::AtomicPool, 0);
    m.expires_at_ms = U64(T0 + 3_600_000);
    maker_signs(&mut m);
    assert!(via_outlayer(&mut d, &m, T0 + 30_000 + MATCH_GRACE_MS).is_ok());
    let mut d = desk();
    let why = via_outlayer(&mut d, &m, T0 + 30_000 + MATCH_GRACE_MS + 1).unwrap_err();
    assert!(why.contains("closed too long ago"), "{why}");
}

#[test]
#[should_panic(expected = "The deal is not waiting for settlement")]
fn a_deal_cannot_settle_twice_at_once() {
    let mut d = desk();
    let id = submit(&mut d, matched(SettlementClass::AtomicPool, 0));
    set(ctx("relayer.test", NearToken::from_millinear(20), T0 + 2_000));
    let _ = d.settle(id, json!([{}, {}]));
    // a self-trading maker's second pair of legs for the same deal
    let _ = d.settle(id, json!([{}, {}]));
}

#[test]
#[should_panic(expected = "The deal is not waiting for settlement")]
fn a_settled_deal_cannot_settle_again() {
    let mut d = desk();
    let id = submit(&mut d, matched(SettlementClass::AtomicPool, 0));
    set(ctx("relayer.test", NearToken::from_millinear(20), T0 + 2_000));
    let _ = d.settle(id, json!([{}, {}]));
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 2_000));
    d.on_settled(id, Ok(json!({ "leaf_index": "6", "root": "0xab" })));
    set(ctx("relayer.test", NearToken::from_millinear(20), T0 + 3_000));
    let _ = d.settle(id, json!([{}, {}]));
}

#[test]
#[should_panic(expected = "Only an unsettled deal expires")]
fn a_deal_cannot_expire_while_settling() {
    let mut d = desk();
    let id = submit(&mut d, matched(SettlementClass::BondedHedge, 10_000_000));
    set(ctx("relayer.test", NearToken::from_millinear(20), T0 + 299_000));
    let _ = d.settle(id, json!([{}, {}]));
    // the pool's answer is still on its way when the deal passes its expiry
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 400_000));
    d.expire(id);
}

#[test]
#[should_panic(expected = "The deal is not settling")]
fn a_settle_answer_needs_a_settle_in_flight() {
    let mut d = desk();
    let id = submit(&mut d, matched(SettlementClass::AtomicPool, 0));
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 2_000));
    d.on_settled(id, Ok(json!({ "leaf_index": "6", "root": "0xab" })));
}

#[test]
fn a_late_settle_answer_still_lands_once() {
    let mut d = desk();
    let id = submit(&mut d, matched(SettlementClass::BondedHedge, 10_000_000));
    set(ctx("relayer.test", NearToken::from_millinear(20), T0 + 299_000));
    let _ = d.settle(id, json!([{}, {}]));
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 400_000));
    assert!(d.on_settled(id, Ok(json!({ "leaf_index": "6", "root": "0xab" }))));
    assert_eq!(d.deal(id).unwrap().status, DealStatus::HedgePending);
    assert_eq!(maker(&d).locked.0, 10_000_000, "the bond stays locked for the hedge leg");
}

#[test]
#[should_panic(expected = "Bond accounting error")]
fn an_unlock_beyond_the_locked_bond_panics() {
    let mut d = desk();
    let id = submit(&mut d, matched(SettlementClass::BondedHedge, 10_000_000));
    // as if another path had already unlocked this bond
    d.makers.get_mut(&"maker.test".parse::<AccountId>().unwrap()).unwrap().locked = U128(0);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 400_000));
    d.expire(id);
}

#[test]
fn bonds_of_two_deals_unlock_separately() {
    let mut d = desk();
    let a = submit(&mut d, matched(SettlementClass::BondedHedge, 10_000_000));
    set(ctx("relayer.test", NearToken::from_millinear(20), T0 + 1_000));
    d.open_rfq(format!("0x{}", "12".repeat(32)), U64(30_000));
    let mut m = matched(SettlementClass::BondedHedge, 20_000_000);
    m.rfq_id = U64(1);
    maker_signs(&mut m);
    set(ctx("relayer.test", NearToken::from_millinear(10), T0 + 1_000));
    let s = sign(&m);
    let b = d.submit_match(m, s);
    assert_eq!(maker(&d).locked.0, 30_000_000);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 400_000));
    d.expire(a);
    assert_eq!(maker(&d).locked.0, 20_000_000);
    assert!(d.deal(a).unwrap().bond_released && !d.deal(b).unwrap().bond_released);
    d.expire(b);
    assert_eq!(maker(&d).locked.0, 0);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdrawing_bond_takes_one_yocto() {
    let mut d = desk();
    set(ctx("maker.test", NearToken::from_yoctonear(0), T0));
    let _ = d.withdraw_bond(U128(1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn pausing_a_maker_takes_one_yocto() {
    let mut d = desk();
    set(ctx("maker.test", NearToken::from_yoctonear(0), T0));
    d.set_maker_active(false);
}

#[test]
fn a_withdrawal_that_returns_a_long_value_is_not_put_back() {
    let mut d = desk();
    set(ctx("maker.test", ONE_YOCTO, T0));
    let _ = d.withdraw_bond(U128(40_000_000));
    with_result(ctx("desk.test", NearToken::from_yoctonear(0), T0), PromiseResult::Successful(vec![b'1'; 100]));
    d.on_bond_withdrawn("maker.test".parse().unwrap(), U128(40_000_000));
    assert_eq!(maker(&d).bond.0, 60_000_000);
}

// ---------- config ----------

fn change() -> ConfigChange {
    ConfigChange {
        owner: "owner2.test".parse().unwrap(),
        outlayer: "outlayer2.test".parse().unwrap(),
        matcher_project: "hushd.test/matcher2".into(),
        secrets_owner: "hushd.test".parse().unwrap(),
        keeper: "keeper2.test".parse().unwrap(),
        outlayer_fee: U128(1),
        min_bond: U128(5),
    }
}

#[test]
fn config_changes_wait_for_the_timelock() {
    let mut d = desk();
    set(ctx("owner.test", ONE_YOCTO, T0));
    let id = d.propose_config(change());
    assert!(get_logs().iter().any(|l| l.contains("config_change") && l.contains("proposed")));
    assert_eq!(d.pending_config().unwrap().apply_after_ns.0, T0 * 1_000_000 + DAY_NS);
    set(ctx("owner.test", ONE_YOCTO, T0 + DAY_NS / 1_000_000));
    d.apply_config(id);
    let c = d.config();
    assert_eq!((c.owner.as_str(), c.keeper.as_str(), c.min_bond.0), ("owner2.test", "keeper2.test", 5));
    // fixed at init, whatever is proposed
    assert_eq!((c.pool.as_str(), c.bond_token.as_str(), c.mpc.as_str(), c.config_timelock_ns.0), ("pool.test", "usdc.test", "signer.test", DAY_NS));
    assert!(d.pending_config().is_none());
}

#[test]
#[should_panic(expected = "The timelock has not passed")]
fn config_changes_cannot_skip_the_timelock() {
    let mut d = desk();
    set(ctx("owner.test", ONE_YOCTO, T0));
    let id = d.propose_config(change());
    set(ctx("owner.test", ONE_YOCTO, T0 + DAY_NS / 1_000_000 - 1));
    d.apply_config(id);
}

#[test]
#[should_panic(expected = "No such pending change")]
fn a_cancelled_config_change_cannot_be_applied() {
    let mut d = desk();
    set(ctx("owner.test", ONE_YOCTO, T0));
    let id = d.propose_config(change());
    d.cancel_config(id);
    assert!(get_logs().iter().any(|l| l.contains("cancelled")));
    set(ctx("owner.test", ONE_YOCTO, T0 + DAY_NS / 1_000_000));
    d.apply_config(id);
}

#[test]
#[should_panic(expected = "already pending")]
fn one_config_change_at_a_time() {
    let mut d = desk();
    set(ctx("owner.test", ONE_YOCTO, T0));
    d.propose_config(change());
    d.propose_config(change());
}

#[test]
#[should_panic(expected = "Owner only")]
fn only_the_owner_proposes_config() {
    let mut d = desk();
    set(ctx("maker.test", ONE_YOCTO, T0));
    d.propose_config(change());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn config_changes_take_one_yocto() {
    let mut d = desk();
    set(ctx("owner.test", NearToken::from_yoctonear(0), T0));
    d.propose_config(change());
}

#[test]
fn the_matcher_input_names_the_desk() {
    let mut d = desk();
    set(ctx("relayer.test", NearToken::from_millinear(30), T0));
    let _ = d.request_match(U64(0), "batch".into());
    // the enclave reads `desk` from its input (matcher/src/main.rs)
    let receipts = near_sdk::test_utils::get_created_receipts();
    let input = receipts[0]
        .actions
        .iter()
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { args, .. } => serde_json::from_slice::<Value>(args).ok(),
            _ => None,
        })
        .map(|args| serde_json::from_str::<Value>(args["input_data"].as_str().unwrap()).unwrap())
        .unwrap();
    assert_eq!(input["desk"], "desk.test");
    assert_eq!(input["cmd"], "match");
}

/// The enclave (matcher/src/terms.rs) signs exactly these bytes for this match; the same
/// hex is pinned in the matcher's tests, so the two layouts cannot drift apart.
#[test]
fn signing_bytes_are_pinned() {
    let desk: AccountId = "desk.hushd.testnet".parse().unwrap();
    let m = MatchResult {
        rfq_id: U64(5),
        maker: "maker-b.hushd.testnet".parse().unwrap(),
        terms_hash: format!("0x{}", "ab".repeat(32)),
        class: SettlementClass::BondedHedge,
        expires_at_ms: U64(1_800_000_300_000),
        bond: U128(5_000_000),
        trader_inner: Some(format!("0x{}", "01".repeat(32))),
        owner_key: Some("ed25519:11111111111111111111111111111111".into()),
        hedge: Some(HedgeSpec { asset: 3, coin: "BTC".into(), is_buy: false, size: "0.0162".into(), limit_px: "61000".into(), deadline_ms: 1_800_000_600_000, testnet: true }),
        maker_sig: Base64VecU8(vec![9u8; 64]),
    };
    let h = hex::encode(near_sdk::env::sha256(m.signing_bytes(&desk)));
    assert_eq!(h, PINNED_MATCH_HASH, "update matcher/src/main.rs PINNED_MATCH_HASH too: {h}");
}

const PINNED_MATCH_HASH: &str = "4735ad2e56f565925a38f0edc16b6339821006b06354e2f8551e2baf9f1f613b";

/// Consent v2 for the shared vector: the same hashes are pinned in
/// packages/protocol/test/protocol.test.ts and matcher/src/main.rs.
#[test]
fn consent_bytes_are_pinned() {
    let desk: AccountId = "desk.hushd.testnet".parse().unwrap();
    let mut m = MatchResult {
        rfq_id: U64(3),
        maker: "maker-a.hushd.testnet".parse().unwrap(),
        terms_hash: format!("0x{}", "ab".repeat(32)),
        class: SettlementClass::BondedHedge,
        expires_at_ms: U64(1_800_000_300_000),
        bond: U128(5_000_000_000),
        trader_inner: None,
        owner_key: None,
        hedge: Some(HedgeSpec { asset: 3, coin: "BTC".into(), is_buy: false, size: "1.45".into(), limit_px: "60000".into(), deadline_ms: 1_800_000_600_000, testnet: true }),
        maker_sig: Base64VecU8(vec![]),
    };
    let hedged = m.consent_bytes(&desk).unwrap();
    assert_eq!(&hedged[..14], b"hushd.quote.v2");
    assert_eq!(hedged.len(), 14 + 4 + 18 + 8 + 32 + 16 + 8 + 1 + 32 + 4 + 21);
    assert_eq!(hex::encode(hedge::spec_hash(m.hedge.as_ref())), PINNED_HEDGE_HASH, "hedge hash");
    assert_eq!(hex::encode(near_sdk::env::sha256(&hedged)), PINNED_CONSENT_HEDGED, "hedged consent");
    m.class = SettlementClass::AtomicPool;
    m.hedge = None;
    m.bond = U128(0);
    let atomic = m.consent_bytes(&desk).unwrap();
    assert_eq!(&atomic[atomic.len() - 25 - 32..atomic.len() - 25], &[0u8; 32], "no hedge: 32 zero bytes");
    assert_eq!(hex::encode(near_sdk::env::sha256(&atomic)), PINNED_CONSENT_ATOMIC, "atomic consent");
}

const PINNED_HEDGE_HASH: &str = "eac12673ba90754c1390ff2158a0c2da8a758ab9837342a89a75cc6392bf9899";
const PINNED_CONSENT_HEDGED: &str = "f0d0c61833ef7c13d51a25431e275de57380f74cf3905b521f9f18875b2ad259";
const PINNED_CONSENT_ATOMIC: &str = "c6059f809116681d28c509cc74bd2c26b72159dc24fc4c351aef7b03a2a36156";
