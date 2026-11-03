use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const T0: u64 = 1_800_000_000_000; // ms

fn enclave() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
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
    d.on_enclave_key(Ok(Some(out)));
    set(ctx("maker.test", NearToken::from_millinear(20), T0));
    d.register_maker("Maker".into(), format!("0x{}", "cd".repeat(32)), "https://maker.test/quote".into(), "fixed".into());
    set(ctx("usdc.test", NearToken::from_yoctonear(0), T0));
    assert!(matches!(d.ft_on_transfer("maker.test".parse().unwrap(), U128(100_000_000), "bond".into()), PromiseOrValue::Value(U128(0))));
    set(ctx("relayer.test", NearToken::from_millinear(20), T0));
    d.open_rfq(format!("0x{}", "11".repeat(32)), U64(30_000));
    d
}

fn hedge_spec() -> HedgeSpec {
    HedgeSpec { asset: 4, coin: "NEAR".into(), is_buy: false, size: "100".into(), limit_px: "2.1".into(), deadline_ms: T0 + 600_000, testnet: true }
}

fn owner_key() -> SigningKey {
    SigningKey::from_bytes(&[9u8; 32])
}

fn matched(class: SettlementClass, bond: u128) -> MatchResult {
    let mut pk = vec![0u8];
    pk.extend_from_slice(&owner_key().verifying_key().to_bytes());
    MatchResult {
        rfq_id: U64(0),
        maker: "maker.test".parse().unwrap(),
        terms_hash: format!("0x{}", "22".repeat(32)),
        class,
        expires_at_ms: U64(T0 + 300_000),
        bond: U128(bond),
        trader_inner: Some(format!("0x00{}", "33".repeat(31))),
        owner_key: Some(PublicKey::try_from(pk).unwrap()),
        hedge: (class == SettlementClass::BondedHedge).then(hedge_spec),
    }
}

fn sign(m: &MatchResult) -> Base64VecU8 {
    Base64VecU8(enclave().sign(&m.signing_bytes()).to_bytes().to_vec())
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
    set(ctx("maker.test", NearToken::from_yoctonear(0), T0));
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
    let id = d.on_match(U64(0), Ok(Some(out))).unwrap();
    assert_eq!(d.deal(id).unwrap().attested_by, "outlayer");
    assert_eq!(d.rfq(U64(0)).unwrap().deal_id, Some(id));
}

#[test]
fn a_failed_or_empty_enclave_run_makes_no_deal() {
    let mut d = desk();
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 1_000));
    assert!(d.on_match(U64(0), Err(PromiseError::Failed)).is_none());
    let none = json!({ "success": true, "result": { "matched": false, "reason": "no quote inside the limit" } }).to_string();
    assert!(d.on_match(U64(0), Ok(Some(none))).is_none());
    assert_eq!(d.stats().deals, 0);
}

#[test]
fn a_match_beyond_free_bond_is_refused() {
    let mut d = desk();
    let m = matched(SettlementClass::BondedHedge, 200_000_000);
    let out = json!({ "success": true, "result": { "matched": true, "match": m } }).to_string();
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 1_000));
    assert!(d.on_match(U64(0), Ok(Some(out))).is_none());
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
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 2_000));
    // a bad submission leaves the deal open
    assert!(!d.on_settled(id, Err(PromiseError::Failed)));
    assert_eq!(d.deal(id).unwrap().status, DealStatus::Matched);
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
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 2_000));
    d.on_settled(id, Ok(json!({ "leaf_index": "6", "root": "0xab" })));
    assert_eq!(d.deal(id).unwrap().status, DealStatus::HedgePending);
    id
}

#[test]
fn a_filled_hedge_closes_settled_and_frees_the_bond() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 3_000));
    let _ = d.sign_hedge_order(id);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 5_000));
    let _ = d.record_hedge(id, true, vec![Evidence { kind: "hyperliquid_fill".into(), reference: "oid 123 @ 2.11".into() }]);
    let deal = d.deal(id).unwrap();
    assert_eq!(deal.receipt.as_ref().unwrap().outcome, Outcome::Settled);
    assert_eq!(deal.receipt.unwrap().evidence.len(), 3);
    assert_eq!(d.maker("maker.test".parse().unwrap()).unwrap().locked.0, 0);
}

#[test]
fn a_failed_hedge_slashes_the_bond_to_a_private_note() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 5_000));
    let _ = d.record_hedge(id, false, vec![Evidence { kind: "hyperliquid_reject".into(), reference: "insufficient margin".into() }]);
    let m = d.maker("maker.test".parse().unwrap()).unwrap();
    assert_eq!((m.bond.0, m.locked.0, m.slashed.0), (90_000_000, 0, 10_000_000));
    set(ctx("desk.test", NearToken::from_yoctonear(0), T0 + 5_000));
    d.on_slash_paid(id, U128(10_000_000), Ok(U128(10_000_000)));
    assert_eq!(d.deal(id).unwrap().receipt.unwrap().outcome, Outcome::Recovered);
    assert_eq!(d.stats().slashed.0, 10_000_000);
}

#[test]
fn an_overdue_hedge_can_be_slashed_by_anyone() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 700_000));
    let _ = d.slash_overdue(id);
    assert_eq!(d.maker("maker.test".parse().unwrap()).unwrap().slashed.0, 10_000_000);
}

#[test]
#[should_panic(expected = "already signed")]
fn one_opening_order_per_deal() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 3_000));
    let _ = d.sign_hedge_order(id);
    let _ = d.sign_hedge_order(id);
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
    set(ctx("anyone.test", NearToken::from_yoctonear(0), T0 + 3_000));
    let _ = d.sign_hedge_order(id);
    set(ctx("keeper.test", NearToken::from_yoctonear(0), T0 + 5_000));
    let _ = d.record_hedge(id, true, vec![]);
    let sig = owner_key().sign(format!("hushd.close:{}", id.0).as_bytes()).to_bytes().to_vec();
    set(ctx("relayer.test", NearToken::from_yoctonear(0), T0 + 6_000));
    let _ = d.close_hedge(id, Base64VecU8(sig));
    assert_eq!(d.deal(id).unwrap().hedge_orders, 2);
}

#[test]
fn the_digest_view_matches_the_signed_order() {
    let mut d = desk();
    let id = hedge_pending(&mut d);
    assert_eq!(d.hedge_digest(id, U64(42), false), hex::encode(hedge::order_digest(&hedge_spec(), 42, false)));
    assert_eq!(d.hedge_path(id), "hushd/hedge/0");
}
