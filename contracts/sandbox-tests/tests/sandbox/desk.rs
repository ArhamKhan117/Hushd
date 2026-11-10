//! The desk and the pool together on a real node: enclave key and matches through
//! the OutLayer double, settlement of the fixture's swap (deal 7) through the pool,
//! reader proofs against the result, a bad settlement, a bonded hedge leg signed
//! through the MPC double, and a slashed bond the pool refused, retried into it.

use crate::common::*;
use near_api::{AccountId, NearToken};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use testresult::TestResult;

const SIGN_KEY: &str = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const ENC_KEY: &str = "0xabababababababababababababababababababababababababababababababab";
const OUTLAYER_FEE: NearToken = NearToken::from_millinear(10);
const MAKER_BOND: u128 = 500;
const HEDGE_BOND: u128 = 100;
/// The fixture's swap legs bind this deal id.
const DEAL: u64 = 7;

struct DeskWorld {
    w: World,
    desk: AccountId,
    outlayer: AccountId,
    mpc: AccountId,
    keeper: AccountId,
}

/// Tokens, the two doubles, the desk (config pointing at them) and the pool with
/// desk_id = desk. The enclave key comes in through OutLayer and maker.sandbox
/// registers and posts a bond.
async fn desk_world(title: &str) -> TestResult<DeskWorld> {
    let mut w = World::start(title).await?;
    let keeper = w.env.account("keeper").await?;
    let (outlayer, _) = w.env.deploy("outlayer", &OUTLAYER_DOUBLE, json!({ "sign_key": SIGN_KEY, "enc_key": ENC_KEY })).await?;
    let (mpc, _) = w.env.deploy("mpc", &MPC_DOUBLE, json!({})).await?;
    let config = json!({
        "owner": w.owner,
        "pool": w.pool,
        "bond_token": w.usdc,
        "outlayer": outlayer,
        "matcher_project": "hushd.sandbox/matcher",
        "secrets_owner": w.owner,
        "mpc": mpc,
        "keeper": keeper,
        "outlayer_fee": OUTLAYER_FEE.as_yoctonear().to_string(),
        "min_bond": "10",
        "config_timelock_ns": "1000000000",
    });
    let (desk, _) = w.env.deploy("desk", &DESK, json!({ "config": config })).await?;
    w.deploy_pool(Some(&desk)).await?;
    let (usdc, btc) = (w.usdc.clone(), w.btc.clone());
    for a in [&desk, &w.alice, &w.relayer, &w.maker] {
        w.register(&usdc, a).await?;
    }
    w.register(&btc, &w.maker).await?;

    // the enclave key, fetched through OutLayer: nobody types it in
    let r = w.env.call_ok(&w.owner, &desk, "refresh_enclave_key", json!({}), OUTLAYER_FEE).await?;
    w.gas.add("refresh_enclave_key (OutLayer round trip)", &r);
    let enclave = w.env.view(&desk, "enclave", json!({})).await?;
    assert_eq!(enclave, json!({ "sign_key": SIGN_KEY, "enc_key": ENC_KEY, "project": "hushd.sandbox/matcher" }));

    // a maker with a bond
    let args = json!({ "name": "Sandbox maker", "enc_key": ENC_KEY, "quote_url": "https://maker.example/quote", "style": "fixed", "quote_key": quote_key() });
    let r = w.env.call_ok(&w.maker, &desk, "register_maker", args, NearToken::from_millinear(10)).await?;
    w.gas.add("register_maker", &r);
    w.mint(&usdc, &w.maker, 1_000).await?;
    let args = json!({ "receiver_id": desk, "amount": MAKER_BOND.to_string(), "memo": null, "msg": "bond" });
    let r = w.env.call_ok(&w.maker, &usdc, "ft_transfer_call", args, ONE_YOCTO).await?;
    w.gas.add("post bond (ft_transfer_call \"bond\")", &r);
    let maker = w.env.view(&desk, "maker", json!({ "account_id": w.maker })).await?;
    assert_eq!(maker["bond"], MAKER_BOND.to_string());
    Ok(DeskWorld { w, desk, outlayer, mpc, keeper })
}

/// The fixture up to the maker's BTC shield: alice shields, sends and cashes out;
/// the maker shields 5 BTC. The tree is then at the root both swap legs name.
async fn fixture_until_maker_shield(w: &mut World) -> TestResult<()> {
    let (usdc, btc, alice, maker) = (w.usdc.clone(), w.btc.clone(), w.alice.clone(), w.maker.clone());
    w.mint(&usdc, &alice, 100).await?;
    w.shield(&alice, "shieldAlice").await?;
    w.send().await?;
    let r = w.cash_out("cash out (transact + payouts)").await?;
    assert_ok(&r, "cash out");
    w.mint(&btc, &maker, 5).await?;
    w.shield(&maker, "shieldMaker").await?;
    assert_eq!(w.root().await?, hex(&s(&w.f["swap"]["legA"]["root"])));
    assert_eq!(w.next_leaf_index().await?, 6);
    Ok(())
}

/// The maker's quote key (ed25519), registered on the desk.
fn quote_signer() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[5u8; 32])
}

fn quote_key() -> String {
    format!("ed25519:{}", bs58::encode(quote_signer().verifying_key().to_bytes()).into_string())
}

/// The trader's per-deal owner key, named in every match.
fn owner_signer() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[9u8; 32])
}

fn owner_key() -> String {
    format!("ed25519:{}", bs58::encode(owner_signer().verifying_key().to_bytes()).into_string())
}

/// Both parties' approvals of the legs' four outputs: "hushd.settle.v1:<desk>:<deal id>:<a0>,<a1>,<b0>,<b1>".
fn approvals(desk: &AccountId, deal_id: u64, legs: &Value) -> Value {
    use base64::Engine;
    use ed25519_dalek::Signer;
    let o = |l: usize, i: usize| legs[l]["commitments"][i].as_str().unwrap().to_string();
    let msg = format!("hushd.settle.v1:{desk}:{deal_id}:{},{},{},{}", o(0, 0), o(0, 1), o(1, 0), o(1, 1));
    let sig = |k: &ed25519_dalek::SigningKey| base64::engine::general_purpose::STANDARD.encode(k.sign(msg.as_bytes()).to_bytes());
    json!({ "trader": sig(&owner_signer()), "maker": sig(&quote_signer()) })
}

/// The settle call's arguments: the fixture's legs for `deal_id`, approved by both parties.
fn settle_args(d: &DeskWorld, deal_id: u64) -> Value {
    let l = legs(&d.w.f);
    json!({ "deal_id": deal_id.to_string(), "approvals": approvals(&d.desk, deal_id, &l), "legs": l })
}

fn put_str(b: &mut Vec<u8>, s: &str) {
    b.extend_from_slice(&(s.len() as u32).to_le_bytes());
    b.extend_from_slice(s.as_bytes());
}

/// sha256 of the hedge spec's borsh bytes (asset u32, coin, is_buy, size, limit_px,
/// deadline u64, testnet), written out by hand here; 32 zero bytes for no hedge.
fn hedge_hash(h: Option<&Value>) -> [u8; 32] {
    let Some(h) = h else { return [0u8; 32] };
    let mut b = (h["asset"].as_u64().unwrap() as u32).to_le_bytes().to_vec();
    put_str(&mut b, h["coin"].as_str().unwrap());
    b.push(h["is_buy"].as_bool().unwrap() as u8);
    put_str(&mut b, h["size"].as_str().unwrap());
    put_str(&mut b, h["limit_px"].as_str().unwrap());
    b.extend_from_slice(&h["deadline_ms"].as_u64().unwrap().to_le_bytes());
    b.push(h["testnet"].as_bool().unwrap() as u8);
    Sha256::digest(&b).into()
}

/// The maker's consent v2: "hushd.quote.v2" ‖ desk ‖ rfq id ‖ terms hash ‖ bond ‖ expiry ‖
/// class ‖ hedge hash ‖ maker, account ids as u32 LE length ‖ utf8.
fn maker_sig(desk: &AccountId, rfq_id: u64, terms_hash: &str, bond: u128, expires_at_ms: u64, hedge: Option<&Value>, maker: &AccountId) -> String {
    use base64::Engine;
    use ed25519_dalek::Signer;
    let mut msg = b"hushd.quote.v2".to_vec();
    put_str(&mut msg, desk.as_str());
    msg.extend_from_slice(&rfq_id.to_le_bytes());
    msg.extend_from_slice(&hex::decode(&terms_hash[2..]).unwrap());
    msg.extend_from_slice(&bond.to_le_bytes());
    msg.extend_from_slice(&expires_at_ms.to_le_bytes());
    msg.push(if hedge.is_some() { 1 } else { 0 });
    msg.extend_from_slice(&hedge_hash(hedge));
    put_str(&mut msg, maker.as_str());
    base64::engine::general_purpose::STANDARD.encode(quote_signer().sign(&msg).to_bytes())
}

/// The matcher's answer for one RFQ, as the OutLayer double hands it back.
fn match_answer(desk: &AccountId, rfq_id: u64, maker: &AccountId, expires_at_ms: u64, hedge: Option<Value>) -> String {
    let bonded = hedge.is_some();
    let terms_hash = format!("0x{:064x}", 0xfeed_0000 + rfq_id);
    let bond: u128 = if bonded { HEDGE_BOND } else { 0 };
    let maker_sig = maker_sig(desk, rfq_id, &terms_hash, bond, expires_at_ms, hedge.as_ref(), maker);
    json!({
        "success": true,
        "result": {
            "matched": true,
            "match": {
                "rfq_id": rfq_id.to_string(),
                "maker": maker,
                "terms_hash": terms_hash,
                "class": if bonded { "bonded_hedge" } else { "atomic_pool" },
                "expires_at_ms": expires_at_ms.to_string(),
                "bond": if bonded { HEDGE_BOND.to_string() } else { "0".into() },
                "trader_inner": if bonded { Some(format!("0x00{}", "33".repeat(31))) } else { None },
                "owner_key": owner_key(),
                "hedge": hedge,
                "maker_sig": maker_sig,
            },
        },
    })
    .to_string()
}

/// A hedge leg for deal 7 whose deadline is after the deal's expiry (open_deals: one hour).
async fn hedge_leg(d: &DeskWorld) -> TestResult<Value> {
    let deadline = d.w.env.now_ms().await? + 7_200_000;
    Ok(json!({ "asset": 4, "coin": "NEAR", "is_buy": false, "size": "100", "limit_px": "2.1", "deadline_ms": deadline, "testnet": true }))
}

/// Open RFQs 0..=7 and have each matched through OutLayer, so deals 0..=7 exist
/// (ids are sequential). Deal 7 carries `hedge7` when given.
async fn open_deals(d: &mut DeskWorld, hedge7: Option<Value>) -> TestResult<()> {
    let w = &mut d.w;
    let expires = w.env.now_ms().await? + 3_600_000;
    for i in 0..=DEAL {
        let args = json!({ "commitment": format!("0x{:064x}", 0xbeef_0000 + i), "window_ms": "600000" });
        let r = w.env.call_ok(&w.relayer, &d.desk, "open_rfq", args, NearToken::from_millinear(10)).await?;
        if i == 0 {
            w.gas.add("open_rfq", &r);
        }
        assert_eq!(r.json::<Value>()?, i.to_string());

        let hedge = if i == DEAL { hedge7.clone() } else { None };
        let args = json!({ "rfq_id": i.to_string(), "sealed_batch": match_answer(&d.desk, i, &w.maker, expires, hedge) });
        let deposit = OUTLAYER_FEE.saturating_add(NearToken::from_millinear(10));
        let r = w.env.call_ok(&w.relayer, &d.desk, "request_match", args, deposit).await?;
        assert!(event(&r, "deal_matched").is_some(), "no deal_matched: {:#?}", r.logs());
        if i == 0 || i == DEAL {
            w.gas.add(&format!("request_match round trip (deal {i})"), &r);
        }
        assert_eq!(r.json::<Value>()?, i.to_string(), "deal ids are sequential");
    }
    let usage = w.env.view(&d.outlayer, "usage", json!({})).await?;
    assert_eq!(usage["requests"], (DEAL + 2).to_string(), "one pubkey request and one per RFQ");
    assert_eq!(usage["last_payer"], w.relayer.as_str());
    Ok(())
}

fn legs(f: &Value) -> Value {
    json!([leg(&f["swap"]["legA"]), leg(&f["swap"]["legB"])])
}

async fn deal(d: &DeskWorld, id: u64) -> TestResult<Value> {
    d.w.env.view(&d.desk, "deal", json!({ "deal_id": id.to_string() })).await
}

/// The desk settles deal 7 through the pool in one call: both legs verify, the deal
/// closes with a `settled` receipt and the tree ends at the fixture's final root.
/// Then the fixture's three reader proofs check against that chain state.
#[tokio::test]
async fn desk_settles_the_swap_through_the_pool() -> TestResult {
    let mut d = desk_world("desk + pool: match, settle, reader proofs").await?;
    fixture_until_maker_shield(&mut d.w).await?;
    open_deals(&mut d, None).await?;

    let args = settle_args(&d, DEAL);
    let w = &mut d.w;
    let r = w.env.call_ok(&w.relayer, &d.desk, "settle", args, NearToken::from_millinear(20)).await?;
    w.gas.add("settle deal 7 (desk -> pool.settle_swap -> desk)", &r);
    let pool_gas = burnt_on(&r, &w.pool);
    let receipt = event(&r, "receipt").ok_or("no receipt event")?;
    assert_eq!(receipt["receipt"]["outcome"], "settled");
    assert!(event(&r, "swap").is_some());
    assert_eq!(r.json::<Value>()?, true);

    let dl = deal(&d, DEAL).await?;
    assert_eq!(dl["status"], "closed");
    assert_eq!(dl["settle_attempts"], 1);
    assert_eq!(dl["receipt"]["outcome"], "settled");
    assert_eq!(dl["attested_by"], "outlayer");
    let w = &mut d.w;
    assert_eq!(w.root().await?, hex(&s(&w.f["rootAfterAll"])));
    assert_eq!(w.next_leaf_index().await?, 10);
    let spend = w.env.view(&w.pool, "spend_of", json!({ "nullifier": w.f["swap"]["legB"]["nullifiers"][0] })).await?;
    assert_eq!(spend["deal_id"], DEAL.to_string());
    assert_eq!(w.stats().await?["swaps"], 1);
    println!("pool.settle_swap burnt {:.2} Tgas of the desk's 230 Tgas budget", pool_gas.as_gas() as f64 / 1e12);
    // the desk forwards 230 Tgas; the worst case seen on testnet (an odd leaf index) is about 177
    assert!(pool_gas.as_gas() < 200_000_000_000_000, "settle_swap burnt {} Tgas: too close to the desk's 230 Tgas budget", pool_gas.as_tgas());

    // the reader proofs: as views, then as transactions to see what they burn
    for kind in ["receipt", "funds", "volume"] {
        let args = disclosure_args(&w.f, kind);
        let check = w.env.view(&w.pool, "verify_disclosure", args.clone()).await?;
        assert_eq!(check["proof_valid"], true, "{kind}: {check}");
        assert_eq!(check["chain_valid"], true, "{kind}: {check}");
        let r = w.env.call_ok(&w.relayer, &w.pool, "verify_disclosure", args, NearToken::from_yoctonear(0)).await?;
        w.gas.add(&format!("verify_disclosure {kind} (as a transaction)"), &r);
        assert_eq!(r.json::<Value>()?, check);
        match kind {
            "receipt" => {
                assert_eq!(check["deal_ids"], json!([DEAL.to_string()]));
                assert_eq!(check["token"], w.usdc.as_str());
            }
            "volume" => assert_eq!(check["deal_ids"], json!([DEAL.to_string()])),
            _ => {}
        }
    }
    Ok(())
}

/// Legs bound to deal 7 sent for deal 6: the pool refuses them (the binding differs),
/// nothing changes in the pool, and deal 6 stays `matched` with one recorded attempt.
#[tokio::test]
async fn a_settle_with_legs_for_another_deal_changes_nothing() -> TestResult {
    let mut d = desk_world("desk + pool: settle with the wrong deal id").await?;
    fixture_until_maker_shield(&mut d.w).await?;
    open_deals(&mut d, None).await?;
    let root_before = d.w.root().await?;

    let args = settle_args(&d, 6);
    let w = &mut d.w;
    let r = w.env.call(&w.relayer, &d.desk, "settle", args, NearToken::from_millinear(20)).await?;
    w.gas.add("settle deal 6 with deal 7's legs (refused)", &r);
    assert!(r.is_success(), "the desk's callback handles the refusal");
    let failed = failures(&r);
    assert!(failed.len() == 1 && failed[0].starts_with("pool.sandbox") && failed[0].contains("Invalid proof"), "{failed:?}");
    assert_eq!(event(&r, "settle_failed").ok_or("no settle_failed")?["deal_id"], "6");
    assert_eq!(r.json::<Value>()?, false);

    let dl = deal(&d, 6).await?;
    assert_eq!(dl["status"], "matched");
    assert_eq!(dl["settle_attempts"], 1);
    assert!(dl["receipt"].is_null());
    let w = &d.w;
    assert_eq!(w.root().await?, root_before);
    assert_eq!(w.next_leaf_index().await?, 6);
    let n = &w.f["swap"]["legA"]["nullifiers"][0];
    assert_eq!(w.env.view(&w.pool, "is_spent", json!({ "nullifier": n })).await?, false);
    assert_eq!(w.stats().await?["swaps"], 0);
    // deal 7 itself is untouched
    assert_eq!(deal(&d, DEAL).await?["settle_attempts"], 0);
    Ok(())
}

/// Deal 7 as a bonded hedge: the spot legs settle through the pool, the desk has the
/// MPC (the double) sign the Hyperliquid order it rebuilds itself, and the keeper's
/// fill report closes the deal as settled and frees the maker's bond.
#[tokio::test]
async fn bonded_hedge_signs_through_the_mpc_and_closes_on_the_fill() -> TestResult {
    let mut d = desk_world("desk + pool + MPC: bonded hedge").await?;
    fixture_until_maker_shield(&mut d.w).await?;
    let hedge = hedge_leg(&d).await?;
    open_deals(&mut d, Some(hedge)).await?;
    let w = &mut d.w;
    let maker = w.env.view(&d.desk, "maker", json!({ "account_id": w.maker })).await?;
    assert_eq!(maker["locked"], HEDGE_BOND.to_string());

    let args = settle_args(&d, DEAL);
    let w = &mut d.w;
    let r = w.env.call_ok(&w.relayer, &d.desk, "settle", args, NearToken::from_millinear(20)).await?;
    w.gas.add("settle deal 7, bonded hedge (spot leg)", &r);
    assert!(event(&r, "spot_settled").is_some());
    let dl = deal(&d, DEAL).await?;
    assert_eq!(dl["status"], "hedge_pending");
    assert_eq!(dl["receipt"]["outcome"], "unresolved");

    let w = &mut d.w;
    // only the keeper or the deal's maker may have the order signed
    let r = w.env.call(&w.relayer, &d.desk, "sign_hedge_order", json!({ "deal_id": DEAL.to_string() }), NearToken::from_yoctonear(0)).await?;
    assert!(failures(&r).join(" ").contains("Only the keeper or the deal's maker"), "{:?}", failures(&r));
    let r = w.env.call_ok(&d.keeper, &d.desk, "sign_hedge_order", json!({ "deal_id": DEAL.to_string() }), NearToken::from_yoctonear(0)).await?;
    w.gas.add("sign_hedge_order (MPC round trip)", &r);
    let signed = r.json::<Value>()?;
    assert_eq!(signed["signature"]["Secp256k1"]["recovery_id"], 0, "{signed}");
    let nonce = s(&signed["nonce"]);
    let usage = w.env.view(&d.mpc, "usage", json!({})).await?;
    assert_eq!(usage["requests"], "1");
    let request: Value = serde_json::from_str(&s(&usage["last_request"]))?;
    let path = w.env.view(&d.desk, "hedge_path", json!({ "deal_id": DEAL.to_string() })).await?;
    assert_eq!(request["path"], path);
    let digest = w.env.view(&d.desk, "hedge_digest", json!({ "deal_id": DEAL.to_string(), "nonce": nonce, "close": false })).await?;
    assert_eq!(request["payload_v2"]["Ecdsa"], digest, "the MPC is asked to sign the order the desk rebuilt");

    let evidence = json!([{ "kind": "hyperliquid_fill", "reference": "sandbox fill" }]);
    let args = json!({ "deal_id": DEAL.to_string(), "filled": true, "evidence": evidence });
    let r = w.env.call_ok(&d.keeper, &d.desk, "record_hedge", args, NearToken::from_yoctonear(0)).await?;
    w.gas.add("record_hedge filled (keeper)", &r);
    let dl = deal(&d, DEAL).await?;
    assert_eq!(dl["status"], "closed");
    assert_eq!(dl["receipt"]["outcome"], "settled");
    assert_eq!(dl["receipt"]["evidence"].as_array().map(|e| e.len()), Some(3), "pool settlement, pool root, fill");
    let maker = d.w.env.view(&d.desk, "maker", json!({ "account_id": d.w.maker })).await?;
    assert_eq!(maker["locked"], "0");
    assert_eq!(maker["bond"], MAKER_BOND.to_string());
    Ok(())
}

/// Deal 7 as a bonded hedge whose leg misses three times while the pool's deposits are
/// paused. The slashed bond comes back from the pool (the token refunds the desk), the
/// deal waits as `slash_refused` and cannot be slashed again; once deposits reopen,
/// anyone's retry lands the bond in the pool as the trader's note.
#[tokio::test]
async fn a_refused_slash_payout_is_retried_into_the_pool() -> TestResult {
    let mut d = desk_world("desk + pool: refused slash payout, retried").await?;
    fixture_until_maker_shield(&mut d.w).await?;
    let hedge = hedge_leg(&d).await?;
    open_deals(&mut d, Some(hedge)).await?;
    let args = settle_args(&d, DEAL);
    let w = &mut d.w;
    let _ = w.env.call_ok(&w.relayer, &d.desk, "settle", args, NearToken::from_millinear(20)).await?;
    let r = w.env.call(&w.owner, &w.pool, "set_deposits_paused", json!({ "paused": true }), NearToken::from_yoctonear(0)).await?;
    assert!(failures(&r).join(" ").contains("exactly 1 yoctoNEAR"), "{:?}", failures(&r));
    let _ = w.env.call_ok(&w.owner, &w.pool, "set_deposits_paused", json!({ "paused": true }), ONE_YOCTO).await?;
    let held_before = w.held(&w.usdc).await?;

    let deal_id = json!({ "deal_id": DEAL.to_string() });
    for attempt in 1..=3 {
        let w = &mut d.w;
        let _ = w.env.call_ok(&d.keeper, &d.desk, "sign_hedge_order", deal_id.clone(), NearToken::from_yoctonear(0)).await?;
        let evidence = json!([{ "kind": "hyperliquid_reject", "reference": format!("attempt {attempt}") }]);
        let args = json!({ "deal_id": DEAL.to_string(), "filled": false, "evidence": evidence });
        let r = w.env.call(&d.keeper, &d.desk, "record_hedge", args, NearToken::from_yoctonear(0)).await?;
        assert!(r.is_success(), "{:?}", failures(&r));
        if attempt < 3 {
            assert!(event(&r, "hedge_retry").is_some(), "{:#?}", r.logs());
            assert_eq!(deal(&d, DEAL).await?["status"], "hedge_pending");
            continue;
        }
        w.gas.add("record_hedge missed, slash refused by the paused pool", &r);
        assert!(event(&r, "bond_slashed").is_some());
        let refused = event(&r, "shield_refused").ok_or("the pool did not refuse")?;
        assert_eq!(refused["reason"], "Deposits are paused");
        assert_eq!(event(&r, "slash_refused").ok_or("no slash_refused")?["held"], HEDGE_BOND.to_string());
    }
    let dl = deal(&d, DEAL).await?;
    assert_eq!(dl["status"], "slash_refused");
    assert_eq!(dl["slash_held"], HEDGE_BOND.to_string());
    assert_eq!(dl["hedge_attempts"], 3);
    let w = &mut d.w;
    let maker = w.env.view(&d.desk, "maker", json!({ "account_id": w.maker })).await?;
    assert_eq!((maker["bond"].clone(), maker["locked"].clone(), maker["slashed"].clone()), (json!((MAKER_BOND - HEDGE_BOND).to_string()), json!("0"), json!(HEDGE_BOND.to_string())));
    assert_eq!(w.env.ft_balance(&w.usdc, &d.desk).await?, MAKER_BOND, "the refused bond is back with the desk");

    // no second slash of the same bond, and no retry while deposits stay paused succeeds
    let r = w.env.call(&w.alice, &d.desk, "slash_overdue", deal_id.clone(), NearToken::from_yoctonear(0)).await?;
    assert!(failures(&r).join(" ").contains("No open hedge leg"), "{:?}", failures(&r));
    let r = w.env.call_ok(&w.alice, &d.desk, "retry_slash_payout", deal_id.clone(), NearToken::from_yoctonear(0)).await?;
    assert!(event(&r, "slash_refused").is_some());
    assert_eq!(deal(&d, DEAL).await?["status"], "slash_refused");

    let w = &mut d.w;
    let _ = w.env.call_ok(&w.owner, &w.pool, "set_deposits_paused", json!({ "paused": false }), ONE_YOCTO).await?;
    let r = w.env.call_ok(&w.alice, &d.desk, "retry_slash_payout", deal_id, NearToken::from_yoctonear(0)).await?;
    w.gas.add("retry_slash_payout (paid into the pool)", &r);
    assert!(event(&r, "shield").is_some(), "{:#?}", r.logs());
    assert_eq!(event(&r, "receipt").ok_or("no receipt")?["receipt"]["outcome"], "recovered");
    let dl = deal(&d, DEAL).await?;
    assert_eq!(dl["status"], "closed");
    assert_eq!(dl["slash_held"], "0");
    let w = &d.w;
    assert_eq!(w.held(&w.usdc).await?, held_before + HEDGE_BOND);
    assert_eq!(w.env.ft_balance(&w.usdc, &d.desk).await?, MAKER_BOND - HEDGE_BOND);
    assert_eq!(w.env.view(&d.desk, "stats", json!({})).await?["slashed"], HEDGE_BOND.to_string());
    Ok(())
}
