//! Hushd matcher enclave: an OutLayer WASI module, run inside Intel TDX.
//!
//! It holds one secret, `PROTECTED_MATCHER_KEY` (32 random bytes generated inside the
//! TEE; nobody, including Hushd, ever sees it), and from it derives an ed25519 key that
//! signs matches and an X25519 key that RFQs and quotes are sealed to.
//!
//! Commands (JSON on stdin, JSON on stdout):
//! - `{"cmd":"pubkey"}`: the two public keys. The desk asks for these through
//!   OutLayer on chain, so the key it trusts provably comes from this code in a TEE.
//! - `{"cmd":"match","rfq_id":..,"rfq_commitment":"0x..","batch":"<base64 JSON>"}`:
//!   opens the sealed RFQ (and checks it is the one committed on chain), opens every
//!   sealed quote, keeps quotes the maker really signed, picks the best one inside the
//!   trader's limit, and returns a signed match plus the agreed terms sealed to each
//!   side. Losing quotes and the trader's limit never leave the enclave.

mod box_;
mod terms;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use terms::{MatchResult, Quote, Request};

fn keys() -> Result<(SigningKey, x25519_dalek::StaticSecret), String> {
    let seed_hex = std::env::var("PROTECTED_MATCHER_KEY").map_err(|_| "PROTECTED_MATCHER_KEY is not set".to_string())?;
    let seed = hex::decode(seed_hex.trim()).map_err(|_| "PROTECTED_MATCHER_KEY is not hex".to_string())?;
    if seed.len() < 32 {
        return Err("PROTECTED_MATCHER_KEY is shorter than 32 bytes".into());
    }
    let sign_seed: [u8; 32] = Sha256::new().chain_update(b"hushd.matcher.sign.v1").chain_update(&seed).finalize().into();
    let enc_seed: [u8; 32] = Sha256::new().chain_update(b"hushd.matcher.enc.v1").chain_update(&seed).finalize().into();
    Ok((SigningKey::from_bytes(&sign_seed), x25519_dalek::StaticSecret::from(enc_seed)))
}

fn now_ms() -> u64 {
    // In NEAR mode the block time is the clock everyone agrees on.
    if let Some(ns) = std::env::var("NEAR_BLOCK_TIMESTAMP").ok().filter(|s| !s.is_empty()).and_then(|s| s.parse::<u64>().ok()) {
        return ns / 1_000_000;
    }
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn pubkey() -> Result<Value, String> {
    let (sign, enc) = keys()?;
    let enc_pub = x25519_dalek::PublicKey::from(&enc);
    Ok(json!({
        "sign_key": format!("0x{}", hex::encode(sign.verifying_key().to_bytes())),
        "enc_key": format!("0x{}", hex::encode(enc_pub.as_bytes())),
    }))
}

fn do_match(input: &Value) -> Result<Value, String> {
    let (sign, enc) = keys()?;
    let rfq_id = input["rfq_id"].as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| input["rfq_id"].as_u64()).ok_or("rfq_id")?;
    let commitment = input["rfq_commitment"].as_str().ok_or("rfq_commitment")?;
    let batch_b64 = input["batch"].as_str().ok_or("batch")?;
    let batch: Value = serde_json::from_slice(&B64.decode(batch_b64).map_err(|_| "batch is not base64")?).map_err(|_| "batch is not JSON")?;

    let rfq_box = B64.decode(batch["rfq"].as_str().ok_or("batch.rfq")?).map_err(|_| "rfq is not base64")?;
    let digest: [u8; 32] = Sha256::digest(&rfq_box).into();
    if format!("0x{}", hex::encode(digest)) != commitment.to_lowercase() {
        return Err("The sealed request is not the one committed on chain".into());
    }
    let req: Request = serde_json::from_slice(&box_::open(&enc, &rfq_box).ok_or("cannot open the request")?).map_err(|e| format!("request: {e}"))?;

    let now = now_ms();
    let mut valid: Vec<Quote> = Vec::new();
    let mut refused = 0u32;
    for q in batch["quotes"].as_array().ok_or("batch.quotes")? {
        let Some(sealed) = q.as_str().and_then(|s| B64.decode(s).ok()) else { refused += 1; continue };
        let Some(plain) = box_::open(&enc, &sealed) else { refused += 1; continue };
        let Ok(quote) = serde_json::from_slice::<Quote>(&plain) else { refused += 1; continue };
        if quote.rfq_id != rfq_id || !maker_signed(&quote, &req) {
            refused += 1;
            continue;
        }
        valid.push(quote);
    }

    let Some(best) = terms::best(&req, &valid, now) else {
        return Ok(json!({ "matched": false, "reason": "no quote inside the limit", "quotes": valid.len(), "refused": refused }));
    };
    let agreed = terms::agreed(&req, best);
    let terms_hash = terms::terms_hash(&agreed);
    let m = MatchResult::new(rfq_id, best, &req, &terms_hash);
    let signature = sign.sign(&m.signing_bytes());

    let for_trader = json!({ "terms": agreed.to_json(), "maker_address": best.maker_address, "terms_hash": format!("0x{}", hex::encode(terms_hash)) });
    let for_maker = json!({ "terms": agreed.to_json(), "trader_address": req.trader.address, "terms_hash": format!("0x{}", hex::encode(terms_hash)) });
    let trader_enc = terms::address_enc_key(&req.trader.address).ok_or("bad trader address")?;
    let maker_enc = terms::address_enc_key(&best.maker_address).ok_or("bad maker address")?;
    Ok(json!({
        "matched": true,
        "match": m.to_json(),
        "signature": B64.encode(signature.to_bytes()),
        "for_trader": B64.encode(box_::seal(&trader_enc, for_trader.to_string().as_bytes())),
        "for_maker": B64.encode(box_::seal(&maker_enc, for_maker.to_string().as_bytes())),
        "quotes": valid.len(),
        "refused": refused,
    }))
}

/// The maker's quote key signed its consent to exactly these terms (the desk checks the
/// same signature against the key the maker registered on chain).
fn maker_signed(q: &Quote, req: &Request) -> bool {
    let (Some(key), Some(sig)) = (q.quote_key_bytes(), q.signature_bytes()) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&key) else { return false };
    let agreed = terms::agreed(req, q);
    let msg = terms::consent_bytes(q.rfq_id, &terms::terms_hash(&agreed), q.bond, q.expires_at_ms);
    vk.verify(&msg, &ed25519_dalek::Signature::from_bytes(&sig)).is_ok()
}

fn main() {
    let mut raw = String::new();
    let out = match io::stdin().read_to_string(&mut raw).map_err(|e| e.to_string()).and_then(|_| serde_json::from_str::<Value>(&raw).map_err(|_| "input is not JSON".to_string())) {
        Err(e) => json!({ "error": e }),
        Ok(input) => match input["cmd"].as_str() {
            Some("pubkey") => pubkey().unwrap_or_else(|e| json!({ "error": e })),
            Some("match") => do_match(&input).unwrap_or_else(|e| json!({ "matched": false, "error": e })),
            _ => json!({ "error": "cmd is pubkey or match" }),
        },
    };
    print!("{out}");
    let _ = io::stdout().flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTEROP: &str = include_str!("../tests/interop.json");

    /// A request and quotes sealed and signed by the TypeScript SDK and protocol package
    /// (services/scripts/gen-matcher-interop.ts) match here exactly as in TypeScript.
    #[test]
    fn matches_what_typescript_sealed_and_signed() {
        let fx: Value = serde_json::from_str(INTEROP).unwrap();
        // SAFETY: tests in this module run in one thread and only read these variables.
        unsafe {
            std::env::set_var("PROTECTED_MATCHER_KEY", fx["enclaveSeedHex"].as_str().unwrap());
            std::env::set_var("NEAR_BLOCK_TIMESTAMP", fx["nowNs"].as_str().unwrap());
        }
        let out = do_match(&fx["input"]).unwrap();
        assert_eq!(out["matched"], json!(true), "{out}");
        assert_eq!(out["match"]["maker"], fx["expect"]["maker"]);
        assert_eq!(out["match"]["terms_hash"], fx["expect"]["termsHash"]);
        assert_eq!(out["refused"], fx["expect"]["refused"]);

        // the match signature verifies under the enclave's published key
        let keys = pubkey().unwrap();
        let vk = VerifyingKey::from_bytes(&hex::decode(&keys["sign_key"].as_str().unwrap()[2..]).unwrap().try_into().unwrap()).unwrap();
        let sig: [u8; 64] = B64.decode(out["signature"].as_str().unwrap()).unwrap().try_into().unwrap();
        let m: terms::MatchResult = {
            // rebuild from JSON the way the desk does, then compare signing bytes
            let j = &out["match"];
            terms::MatchResult {
                rfq_id: j["rfq_id"].as_str().unwrap().parse().unwrap(),
                maker: j["maker"].as_str().unwrap().into(),
                terms_hash: j["terms_hash"].as_str().unwrap().into(),
                class: 0,
                expires_at_ms: j["expires_at_ms"].as_str().unwrap().parse().unwrap(),
                bond: j["bond"].as_str().unwrap().parse().unwrap(),
                trader_inner: j["trader_inner"].as_str().map(Into::into),
                owner_key: j["owner_key"].as_str().map(Into::into),
                hedge: None,
                maker_sig: B64.decode(j["maker_sig"].as_str().unwrap()).unwrap(),
            }
        };
        assert!(vk.verify(&m.signing_bytes(), &ed25519_dalek::Signature::from_bytes(&sig)).is_ok());

        // the trader (seed 0x01..) opens its copy of the agreed terms; the maker's key cannot
        let trader_secret: [u8; 32] = Sha256::new().chain_update(b"hushd.enc.v1").chain_update([1u8; 32]).finalize().into();
        let trader = x25519_dalek::StaticSecret::from(trader_secret);
        let for_trader = B64.decode(out["for_trader"].as_str().unwrap()).unwrap();
        let opened: Value = serde_json::from_slice(&box_::open(&trader, &for_trader).unwrap()).unwrap();
        assert_eq!(opened["terms_hash"], fx["expect"]["termsHash"]);
        assert_eq!(opened["terms"]["makerGives"]["amount"], json!("1620000"));
        let maker_secret: [u8; 32] = Sha256::new().chain_update(b"hushd.enc.v1").chain_update([3u8; 32]).finalize().into();
        assert!(box_::open(&x25519_dalek::StaticSecret::from(maker_secret), &for_trader).is_none());
    }

    #[test]
    fn a_request_that_is_not_the_committed_one_is_refused() {
        let fx: Value = serde_json::from_str(INTEROP).unwrap();
        unsafe { std::env::set_var("PROTECTED_MATCHER_KEY", fx["enclaveSeedHex"].as_str().unwrap()) };
        let mut input = fx["input"].clone();
        input["rfq_commitment"] = json!(format!("0x{}", "00".repeat(32)));
        assert!(do_match(&input).unwrap_err().contains("not the one committed"));
    }
}

#[cfg(test)]
mod layout {
    use super::terms::{HedgeSpec, MatchResult};
    use sha2::{Digest, Sha256};

    /// The same match as `signing_bytes_are_pinned` in contracts/desk/src/tests.rs: the
    /// enclave's bytes must hash to the desk's pinned value, or the desk would refuse every match.
    const PINNED_MATCH_HASH: &str = "9dd8983acbabf24f758ab173f0251632dc9d6fe4e9a60b12844e1ff90e1ae47c";

    #[test]
    fn signing_bytes_match_the_desk() {
        let m = MatchResult {
            rfq_id: 5,
            maker: "maker-b.hushd.testnet".into(),
            terms_hash: format!("0x{}", "ab".repeat(32)),
            class: 1,
            expires_at_ms: 1_800_000_300_000,
            bond: 5_000_000,
            trader_inner: Some(format!("0x{}", "01".repeat(32))),
            owner_key: Some("ed25519:11111111111111111111111111111111".into()),
            hedge: Some(HedgeSpec { asset: 3, coin: "BTC".into(), is_buy: false, size: "0.0162".into(), limit_px: "61000".into(), deadline_ms: 1_800_000_600_000, testnet: true }),
            maker_sig: vec![9u8; 64],
        };
        assert_eq!(hex::encode(Sha256::digest(m.signing_bytes())), PINNED_MATCH_HASH);
    }
}
