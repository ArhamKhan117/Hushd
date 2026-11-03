use super::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;

const OWNER: &str = "owner.test";
const RELAYER: &str = "relayer.test";
const ALICE: &str = "alice.test";

fn ctx(who: &str, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("board.test".parse().unwrap())
        .predecessor_account_id(who.parse().unwrap())
        .signer_account_id(who.parse().unwrap())
        .attached_deposit(deposit)
        .block_height(7)
        .block_timestamp(42);
    testing_env!(b.build());
}

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn near(milli: u128) -> NearToken {
    NearToken::from_millinear(milli)
}

fn board(max: Option<u32>) -> Board {
    ctx(OWNER, NearToken::from_yoctonear(0));
    Board::new(id(OWNER), max)
}

/// A board where the relayer holds 1 NEAR of storage balance.
fn funded() -> Board {
    let mut b = board(None);
    ctx(RELAYER, near(1_000));
    b.storage_deposit(None, None);
    b
}

fn post_as(b: &mut Board, who: &str, data: &[u8], tag: Option<&str>) -> u64 {
    ctx(who, NearToken::from_yoctonear(0));
    b.post(Base64VecU8(data.to_vec()), tag.map(String::from)).0
}

fn total(b: &Board, who: &str) -> NearToken {
    b.storage_balance_of(id(who)).unwrap().total
}

/// Transfers the last call scheduled, as (receiver, yoctoNEAR).
fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

// ---------- posting and paging ----------

#[test]
fn posts_and_pages_through_them() {
    let mut b = funded();
    assert_eq!(b.count().0, 0);
    for i in 0..5u8 {
        assert_eq!(post_as(&mut b, RELAYER, &[i; 10], Some("note")), i as u64);
    }
    assert_eq!(b.count().0, 5);

    let page = b.posts(U64(0), 2);
    assert_eq!(page.iter().map(|p| p.index.0).collect::<Vec<_>>(), vec![0, 1]);
    let page = b.posts(U64(3), 10);
    assert_eq!(page.iter().map(|p| p.index.0).collect::<Vec<_>>(), vec![3, 4]);
    assert!(b.posts(U64(5), 10).is_empty());
    assert!(b.posts(U64(u64::MAX), 10).is_empty());

    let p = b.get_post(U64(2)).unwrap();
    assert_eq!(p.data.0, vec![2u8; 10]);
    assert_eq!(p.tag.as_deref(), Some("note"));
    assert_eq!((p.block_height.0, p.timestamp_ns.0), (7, 42));
    assert!(b.get_post(U64(5)).is_none());
    assert!(b.get_post(U64(u64::MAX)).is_none());
}

#[test]
fn a_page_holds_at_most_100_posts() {
    let mut b = funded();
    for _ in 0..105 {
        post_as(&mut b, RELAYER, b"x", None);
    }
    assert_eq!(b.posts(U64(0), 1_000).len(), 100);
    assert_eq!(b.posts(U64(100), 1_000).len(), 5);
}

#[test]
fn a_post_without_a_tag_keeps_none() {
    let mut b = funded();
    post_as(&mut b, RELAYER, b"ciphertext", None);
    assert!(b.get_post(U64(0)).unwrap().tag.is_none());
}

// ---------- limits ----------

#[test]
fn a_post_at_the_size_limit_and_a_32_byte_tag_are_accepted() {
    let mut b = board(Some(16));
    ctx(RELAYER, near(1_000));
    b.storage_deposit(None, None);
    post_as(&mut b, RELAYER, &[1; 16], Some(&"t".repeat(32)));
    assert_eq!(b.count().0, 1);
}

#[test]
#[should_panic(expected = "A post is at most 16 bytes")]
fn a_post_over_the_size_limit_is_refused() {
    let mut b = board(Some(16));
    ctx(RELAYER, near(1_000));
    b.storage_deposit(None, None);
    post_as(&mut b, RELAYER, &[1; 17], None);
}

#[test]
#[should_panic(expected = "A post is at most 2048 bytes")]
fn the_default_size_limit_is_2048() {
    let mut b = funded();
    post_as(&mut b, RELAYER, &[1; 2049], None);
}

#[test]
#[should_panic(expected = "A post cannot be empty")]
fn an_empty_post_is_refused() {
    let mut b = funded();
    post_as(&mut b, RELAYER, &[], None);
}

#[test]
#[should_panic(expected = "A tag is at most 32 bytes")]
fn a_long_tag_is_refused() {
    let mut b = funded();
    post_as(&mut b, RELAYER, b"x", Some(&"t".repeat(33)));
}

// ---------- storage charged to the poster ----------

#[test]
fn storage_is_charged_to_the_poster() {
    let mut b = funded();
    ctx(ALICE, near(1_000));
    b.storage_deposit(None, None);

    let before = total(&b, RELAYER);
    ctx(RELAYER, NearToken::from_yoctonear(0));
    let usage = env::storage_usage();
    b.post(Base64VecU8(vec![9; 200]), Some("note".into()));
    let added = env::storage_usage() - usage;
    assert!(added > 200, "the post's bytes are measured");

    let cost = env::storage_byte_cost().saturating_mul(added as u128);
    assert_eq!(total(&b, RELAYER), before.saturating_sub(cost));
    assert_eq!(total(&b, ALICE), near(1_000), "only the poster pays");
}

#[test]
#[should_panic(expected = "Storage balance too low")]
fn a_short_balance_cannot_post() {
    let mut b = board(None);
    ctx(RELAYER, b.storage_balance_bounds().min);
    b.storage_deposit(None, Some(true));
    post_as(&mut b, RELAYER, b"x", None);
}

#[test]
#[should_panic(expected = "Register with storage_deposit before posting")]
fn an_unregistered_account_cannot_post() {
    let mut b = board(None);
    post_as(&mut b, ALICE, b"x", None);
}

// ---------- events ----------

#[test]
fn the_post_event_never_names_the_poster() {
    let mut b = funded();
    post_as(&mut b, RELAYER, b"ciphertext", Some("deal"));

    let logs = get_logs();
    assert_eq!(logs.len(), 1);
    for log in &logs {
        assert!(!log.contains(RELAYER) && !log.contains("relayer"), "a log names the poster: {log}");
    }
    let event: Value = serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(
        event,
        serde_json::json!({
            "standard": "hushd",
            "version": "1.0.0",
            "event": "post",
            "data": [{ "index": "0", "bytes": 10, "tag": "deal" }],
        })
    );
}

// ---------- NEP-145 ----------

#[test]
fn the_minimum_covers_the_balance_entry_of_the_longest_account() {
    let mut b = board(None);
    let bounds = b.storage_balance_bounds();
    assert!(bounds.max.is_none());

    let longest = "a".repeat(64);
    ctx(&longest, bounds.min);
    let usage = env::storage_usage();
    b.storage_deposit(None, Some(true));
    b.balances.flush();
    let used = env::storage_byte_cost().saturating_mul((env::storage_usage() - usage) as u128);
    assert!(!used.is_zero() && used <= bounds.min);
}

#[test]
fn deposit_registers_refunds_extra_and_tops_up() {
    let mut b = board(None);
    let min = b.storage_balance_bounds().min;
    assert!(b.storage_balance_of(id(RELAYER)).is_none());

    // registration_only keeps the minimum and refunds the rest
    ctx(RELAYER, near(500));
    let bal = b.storage_deposit(None, Some(true));
    assert_eq!((bal.total, bal.available), (min, NearToken::from_yoctonear(0)));
    assert_eq!(transfers(), vec![(RELAYER.into(), near(500).saturating_sub(min).as_yoctonear())]);

    // registration_only on a registered account refunds everything
    ctx(RELAYER, near(10));
    assert_eq!(b.storage_deposit(None, Some(true)).total, min);
    assert_eq!(transfers(), vec![(RELAYER.into(), near(10).as_yoctonear())]);

    // a plain deposit tops up, and anyone can pay for another account
    ctx(ALICE, near(300));
    let bal = b.storage_deposit(Some(id(RELAYER)), None);
    assert_eq!((bal.total, bal.available), (min.saturating_add(near(300)), near(300)));
    assert!(transfers().is_empty());
    assert!(b.storage_balance_of(id(ALICE)).is_none());
}

#[test]
#[should_panic(expected = "Attach at least")]
fn registering_below_the_minimum_is_refused() {
    let mut b = board(None);
    let min = b.storage_balance_bounds().min;
    ctx(RELAYER, min.saturating_sub(NearToken::from_yoctonear(1)));
    b.storage_deposit(None, None);
}

#[test]
fn withdraw_pays_out_the_available_balance_only() {
    let mut b = funded();
    let min = b.storage_balance_bounds().min;

    ctx(RELAYER, NearToken::from_yoctonear(1));
    let bal = b.storage_withdraw(Some(near(400)));
    assert_eq!(bal.total, near(600));
    assert_eq!(transfers(), vec![(RELAYER.into(), near(400).as_yoctonear())]);

    ctx(RELAYER, NearToken::from_yoctonear(1));
    let bal = b.storage_withdraw(None);
    assert_eq!((bal.total, bal.available), (min, NearToken::from_yoctonear(0)));
    assert_eq!(transfers(), vec![(RELAYER.into(), near(600).saturating_sub(min).as_yoctonear())]);
}

#[test]
#[should_panic(expected = "Cannot withdraw more than the available balance")]
fn withdrawing_more_than_available_is_refused() {
    let mut b = funded();
    ctx(RELAYER, NearToken::from_yoctonear(1));
    b.storage_withdraw(Some(near(1_000)));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_needs_one_yocto() {
    let mut b = funded();
    ctx(RELAYER, NearToken::from_yoctonear(0));
    b.storage_withdraw(None);
}

#[test]
fn unregister_returns_the_whole_balance_once() {
    let mut b = funded();
    post_as(&mut b, RELAYER, b"x", None);
    let left = total(&b, RELAYER);

    ctx(RELAYER, NearToken::from_yoctonear(1));
    assert!(b.storage_unregister(Some(false)));
    assert_eq!(transfers(), vec![(RELAYER.into(), left.as_yoctonear())]);
    assert!(b.storage_balance_of(id(RELAYER)).is_none());
    assert_eq!(b.count().0, 1, "posts stay");

    ctx(RELAYER, NearToken::from_yoctonear(1));
    assert!(!b.storage_unregister(None));
    assert!(transfers().is_empty());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn unregister_needs_one_yocto() {
    let mut b = funded();
    ctx(RELAYER, NearToken::from_yoctonear(0));
    b.storage_unregister(None);
}

// ---------- owner ----------

#[test]
fn the_owner_changes_the_size_limit() {
    let mut b = board(None);
    ctx(OWNER, NearToken::from_yoctonear(0));
    b.set_max_post_bytes(4096);
    assert_eq!(b.max_post_bytes(), 4096);
    assert!(get_logs()[0].contains(r#""event":"max_post_bytes""#));
}

#[test]
#[should_panic(expected = "Owner only")]
fn only_the_owner_changes_the_size_limit() {
    let mut b = board(None);
    ctx(RELAYER, NearToken::from_yoctonear(0));
    b.set_max_post_bytes(4096);
}

#[test]
#[should_panic(expected = "at least 1 byte")]
fn the_size_limit_cannot_be_zero() {
    let mut b = board(None);
    ctx(OWNER, NearToken::from_yoctonear(0));
    b.set_max_post_bytes(0);
}
