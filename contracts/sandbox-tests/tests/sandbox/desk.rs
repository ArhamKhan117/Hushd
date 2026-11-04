//! The desk and the pool together on a real node: enclave key and matches through
//! the OutLayer double, settlement of the fixture's swap (deal 7) through the pool,
//! reader proofs against the result, a bad settlement, and a bonded hedge leg signed
//! through the MPC double.

use crate::common::*;
use near_api::{AccountId, NearToken};
use serde_json::{Value, json};
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
    let args = json!({ "name": "Sandbox maker", "enc_key": ENC_KEY, "quote_url": "https://maker.example/quote", "style": "fixed" });
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

/// The matcher's answer for one RFQ, as the OutLayer double hands it back.
fn match_answer(rfq_id: u64, maker: &AccountId, expires_at_ms: u64, hedge: Option<Value>) -> String {
    let bonded = hedge.is_some();
    json!({
        "success": true,
        "result": {
            "matched": true,
            "match": {
                "rfq_id": rfq_id.to_string(),
                "maker": maker,
                "terms_hash": format!("0x{:064x}", 0xfeed_0000 + rfq_id),
                "class": if bonded { "bonded_hedge" } else { "atomic_pool" },
                "expires_at_ms": expires_at_ms.to_string(),
                "bond": if bonded { HEDGE_BOND.to_string() } else { "0".into() },
                "trader_inner": if bonded { Some(format!("0x00{}", "33".repeat(31))) } else { None },
                "owner_key": null,
                "hedge": hedge,
            },
        },
    })
    .to_string()
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
        let args = json!({ "rfq_id": i.to_string(), "sealed_batch": match_answer(i, &w.maker, expires, hedge) });
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

    let w = &mut d.w;
    let args = json!({ "deal_id": DEAL.to_string(), "legs": legs(&w.f) });
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
    println!("pool.settle_swap burnt {:.2} Tgas of the desk's 180 Tgas budget", pool_gas.as_gas() as f64 / 1e12);

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

    let w = &mut d.w;
    let args = json!({ "deal_id": "6", "legs": legs(&w.f) });
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
    let deadline = d.w.env.now_ms().await? + 1_800_000;
    let hedge = json!({ "asset": 4, "coin": "NEAR", "is_buy": false, "size": "100", "limit_px": "2.1", "deadline_ms": deadline, "testnet": true });
    open_deals(&mut d, Some(hedge)).await?;
    let w = &mut d.w;
    let maker = w.env.view(&d.desk, "maker", json!({ "account_id": w.maker })).await?;
    assert_eq!(maker["locked"], HEDGE_BOND.to_string());

    let args = json!({ "deal_id": DEAL.to_string(), "legs": legs(&w.f) });
    let r = w.env.call_ok(&w.relayer, &d.desk, "settle", args, NearToken::from_millinear(20)).await?;
    w.gas.add("settle deal 7, bonded hedge (spot leg)", &r);
    assert!(event(&r, "spot_settled").is_some());
    let dl = deal(&d, DEAL).await?;
    assert_eq!(dl["status"], "hedge_pending");
    assert_eq!(dl["receipt"]["outcome"], "unresolved");

    let w = &mut d.w;
    let r = w.env.call_ok(&w.relayer, &d.desk, "sign_hedge_order", json!({ "deal_id": DEAL.to_string() }), NearToken::from_yoctonear(0)).await?;
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
