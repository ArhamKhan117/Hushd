//! The pool and the testnet token on a real node: shield, private send, cash out,
//! and a cash out the token cannot deliver.

use crate::common::*;
use near_api::NearToken;
use serde_json::json;
use testresult::TestResult;

/// Alice shields 100 USDC, sends the note privately and cashes out 30 of it (29 to
/// her, a fee of 1 to the relayer). Every proof verifies on chain, the tree follows
/// the fixture root by root and the tokens land.
#[tokio::test]
async fn shield_send_and_cash_out() -> TestResult {
    let mut w = World::start("pool + token: shield, send, cash out").await?;
    w.deploy_pool(None).await?;
    let (usdc, alice, relayer) = (w.usdc.clone(), w.alice.clone(), w.relayer.clone());
    w.register(&usdc, &alice).await?;
    w.register(&usdc, &relayer).await?;
    w.mint(&usdc, &alice, 100).await?;

    // shield: the pool computes the commitment from what it received
    w.shield(&alice, "shieldAlice").await?;
    assert_eq!(w.root().await?, hex(&s(&w.f["send"]["root"])));
    assert_eq!(w.next_leaf_index().await?, 1);
    assert_eq!(w.held(&usdc).await?, 100);
    assert_eq!(w.env.ft_balance(&usdc, &alice).await?, 0);

    // private send: two notes out, no token named
    let inserted = w.send().await?;
    assert_eq!(inserted["leaf_index"], "1");
    assert_eq!(inserted["root"], hex(&s(&w.f["cashOut"]["root"])));
    assert_eq!(w.root().await?, hex(&s(&w.f["cashOut"]["root"])));
    assert_eq!(w.next_leaf_index().await?, 3);
    let n0 = s(&w.f["send"]["nullifiers"][0]);
    let spend = w.env.view(&w.pool, "spend_of", json!({ "nullifier": n0 })).await?;
    assert_eq!(spend["outputs"][0], hex(&s(&w.f["send"]["commitments"][0])));
    assert!(spend["deal_id"].is_null());

    // cash out: 29 to alice, 1 to the relayer, the change stays shielded
    let r = w.cash_out("cash out (transact + 2 ft_transfer + on_payout)").await?;
    assert_ok(&r, "cash out");
    let payout = event(&r, "payout").ok_or("no payout event")?;
    assert_eq!(payout["outcome"], "paid");
    assert_eq!(payout["amount"], "29");
    assert_eq!(w.env.ft_balance(&usdc, &alice).await?, 29);
    assert_eq!(w.env.ft_balance(&usdc, &relayer).await?, 1);
    assert_eq!(w.held(&usdc).await?, 70);
    assert_eq!(w.next_leaf_index().await?, 5);

    let stats = w.stats().await?;
    assert_eq!(stats, json!({ "shields": 1, "transfers": 1, "cash_outs": 1, "swaps": 0, "refunds": 0 }));

    // the same send again is a double spend
    let r = w.env.call(&relayer, &w.pool, "transact", send_args(&w.f), STORAGE).await?;
    assert!(r.is_failure() && failures(&r).join(" ").contains("A note is already spent"), "{:?}", failures(&r));
    Ok(())
}

/// alice.sandbox never registers on the token, so the pool's `ft_transfer` of her 29
/// fails. The pool turns them into a refund note (one more leaf, `payout` event with
/// outcome `refunded`), keeps holding them, and still pays the relayer's fee.
#[tokio::test]
async fn cash_out_to_an_unregistered_recipient_becomes_a_refund_note() -> TestResult {
    let mut w = World::start("pool + token: refunded cash out").await?;
    w.deploy_pool(None).await?;
    let (usdc, alice, relayer) = (w.usdc.clone(), w.alice.clone(), w.relayer.clone());
    // Someone else funds the shield: the note is alice's through `inner`, not the sender.
    let funder = w.env.account("funder").await?;
    let r = w.env.call_ok(&funder, &usdc, "faucet", json!({}), NearToken::from_yoctonear(0)).await?;
    w.gas.add("faucet (registers the caller)", &r);
    w.register(&usdc, &relayer).await?;
    let storage = w.env.view(&usdc, "storage_balance_of", json!({ "account_id": alice })).await?;
    assert!(storage.is_null(), "alice.sandbox must not be registered on usdc");

    w.shield(&funder, "shieldAlice").await?;
    w.send().await?;
    let r = w.cash_out("cash out, recipient unregistered (refund note)").await?;

    let failed = failures(&r);
    assert!(
        failed.len() == 1 && failed[0].starts_with("usdc.sandbox") && failed[0].contains("not registered"),
        "expected only the transfer to alice to fail: {failed:?}"
    );
    let payout = event(&r, "payout").ok_or("no payout event")?;
    assert_eq!(payout["outcome"], "refunded", "{payout}");
    assert_eq!(payout["to"], alice.as_str());
    assert_eq!(payout["amount"], "29");
    assert_eq!(payout["leaf_index"], "5");
    assert!(payout["refund_commitment"].is_string());
    assert_eq!(payout["root"], w.root().await?);

    // five leaves from the scenario plus the refund note
    assert_eq!(w.next_leaf_index().await?, 6);
    assert_eq!(w.held(&usdc).await?, 100 - 30 + 29);
    assert_eq!(w.env.ft_balance(&usdc, &alice).await?, 0);
    assert_eq!(w.env.ft_balance(&usdc, &relayer).await?, 1);
    let unclaimed = w.env.view(&w.pool, "unclaimed", json!({ "account": alice, "token": usdc })).await?;
    assert_eq!(unclaimed, "0", "a refund note is not also held for claiming");
    let stats = w.stats().await?;
    assert_eq!(stats["cash_outs"], 1);
    assert_eq!(stats["refunds"], 1);
    Ok(())
}
