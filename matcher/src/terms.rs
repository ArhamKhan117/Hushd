//! Requests, quotes and agreed terms: the Rust twin of packages/protocol/src/package.ts.
//! The canonical bytes here must equal the TypeScript ones (see the vectors test).

use borsh::BorshSerialize;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn de_u128<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
    let v = Value::deserialize(d)?;
    match v {
        Value::String(s) => s.parse().map_err(serde::de::Error::custom),
        Value::Number(n) => n.as_u64().map(u128::from).ok_or_else(|| serde::de::Error::custom("amount")),
        _ => Err(serde::de::Error::custom("amount")),
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct Leg {
    pub token: String,
    #[serde(deserialize_with = "de_u128")]
    pub amount: u128,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuySide {
    pub token: String,
    #[serde(deserialize_with = "de_u128")]
    pub min_amount: u128,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HedgeWish {
    pub coin: String,
    pub testnet: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Trader {
    pub address: String,
    pub refund_inner: String,
    pub owner_key: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub kind: String,
    pub sell: Leg,
    pub buy: BuySide,
    pub hedge: Option<HedgeWish>,
    pub expires_in_ms: u64,
    pub trader: Trader,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hedge {
    pub coin: String,
    pub asset: u32,
    pub is_buy: bool,
    pub size: String,
    pub limit_px: String,
    pub deadline_ms: u64,
    pub testnet: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub rfq_id: u64,
    pub maker: String,
    pub give: Leg,
    pub take: Leg,
    pub hedge: Option<Hedge>,
    #[serde(deserialize_with = "de_u128")]
    pub bond: u128,
    pub expires_at_ms: u64,
    pub maker_address: String,
    /// The maker's quote key, "ed25519:<base58>", as registered on the desk.
    pub quote_key: String,
    /// ed25519 over consent_bytes, base64.
    pub signature: String,
}

impl Quote {
    pub fn quote_key_bytes(&self) -> Option<[u8; 32]> {
        let b58 = self.quote_key.strip_prefix("ed25519:")?;
        bs58_decode(b58)?.try_into().ok()
    }
    pub fn signature_bytes(&self) -> Option<[u8; 64]> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(&self.signature).ok()?.try_into().ok()
    }
}

pub struct Agreed {
    pub rfq_id: u64,
    pub maker: String,
    pub class: u8,
    pub trader_gives: Leg,
    pub maker_gives: Leg,
    pub hedge: Option<Hedge>,
    pub bond: u128,
    pub expires_at_ms: u64,
}

pub const CLASS_NAMES: [&str; 3] = ["atomic_pool", "bonded_hedge", "atomic_intents"];

impl Agreed {
    pub fn to_json(&self) -> Value {
        json!({
            "rfqId": self.rfq_id,
            "maker": self.maker,
            "class": CLASS_NAMES[self.class as usize],
            "traderGives": { "token": self.trader_gives.token, "amount": self.trader_gives.amount.to_string() },
            "makerGives": { "token": self.maker_gives.token, "amount": self.maker_gives.amount.to_string() },
            "hedge": self.hedge.as_ref().map(|h| json!({ "venue": "hyperliquid", "coin": h.coin, "asset": h.asset, "isBuy": h.is_buy,
                "size": h.size, "limitPx": h.limit_px, "deadlineMs": h.deadline_ms, "testnet": h.testnet })),
            "bond": self.bond.to_string(),
            "expiresAtMs": self.expires_at_ms,
        })
    }
}

pub fn agreed(req: &Request, q: &Quote) -> Agreed {
    Agreed {
        rfq_id: q.rfq_id,
        maker: q.maker.clone(),
        class: if req.kind == "spot" { 0 } else { 1 },
        trader_gives: q.take.clone(),
        maker_gives: q.give.clone(),
        hedge: q.hedge.clone(),
        bond: q.bond,
        expires_at_ms: q.expires_at_ms,
    }
}

struct W(Vec<u8>);
impl W {
    fn str(&mut self, s: &str) {
        self.0.extend_from_slice(&(s.len() as u32).to_le_bytes());
        self.0.extend_from_slice(s.as_bytes());
    }
}

pub fn terms_bytes(t: &Agreed) -> Vec<u8> {
    let mut w = W(b"hushd.terms.v1".to_vec());
    w.0.extend_from_slice(&t.rfq_id.to_le_bytes());
    w.str(&t.maker);
    w.0.push(t.class);
    w.str(&t.trader_gives.token);
    w.0.extend_from_slice(&t.trader_gives.amount.to_le_bytes());
    w.str(&t.maker_gives.token);
    w.0.extend_from_slice(&t.maker_gives.amount.to_le_bytes());
    match &t.hedge {
        Some(h) => {
            w.0.push(1);
            w.0.extend_from_slice(&h.asset.to_le_bytes());
            w.str(&h.coin);
            w.0.push(h.is_buy as u8);
            w.str(&h.size);
            w.str(&h.limit_px);
            w.0.extend_from_slice(&h.deadline_ms.to_le_bytes());
            w.0.push(h.testnet as u8);
        }
        None => w.0.push(0),
    }
    w.0.extend_from_slice(&t.bond.to_le_bytes());
    w.0.extend_from_slice(&t.expires_at_ms.to_le_bytes());
    w.0
}

pub fn terms_hash(t: &Agreed) -> [u8; 32] {
    Sha256::digest(terms_bytes(t)).into()
}

pub fn consent_bytes(rfq_id: u64, terms_hash: &[u8; 32], bond: u128, expires_at_ms: u64) -> Vec<u8> {
    let mut b = b"hushd.quote.v1".to_vec();
    b.extend_from_slice(&rfq_id.to_le_bytes());
    b.extend_from_slice(terms_hash);
    b.extend_from_slice(&bond.to_le_bytes());
    b.extend_from_slice(&expires_at_ms.to_le_bytes());
    b
}

/// Same rule as `bestQuote` in the protocol package: the most for the trader, inside the
/// limit, still valid long enough, with a hedge exactly when the package asks for one.
pub fn best<'a>(req: &Request, quotes: &'a [Quote], now_ms: u64) -> Option<&'a Quote> {
    let wants_hedge = req.kind != "spot";
    let mut ok: Vec<&Quote> = quotes
        .iter()
        .filter(|q| {
            q.give.token == req.buy.token
                && q.take.token == req.sell.token
                && q.take.amount == req.sell.amount
                && q.give.amount >= req.buy.min_amount
                && q.expires_at_ms >= now_ms + req.expires_in_ms.min(60_000)
                && q.hedge.is_some() == wants_hedge
                && match (&q.hedge, &req.hedge) {
                    (Some(h), Some(w)) => h.coin == w.coin && h.testnet == w.testnet,
                    (None, _) => true,
                    _ => false,
                }
        })
        .collect();
    ok.sort_by(|a, b| b.give.amount.cmp(&a.give.amount).then(a.expires_at_ms.cmp(&b.expires_at_ms)));
    ok.first().copied()
}

// ---------- the match the desk checks (borsh layout = desk's MatchResult) ----------

#[derive(BorshSerialize)]
pub struct HedgeSpec {
    pub asset: u32,
    pub coin: String,
    pub is_buy: bool,
    pub size: String,
    pub limit_px: String,
    pub deadline_ms: u64,
    pub testnet: bool,
}

#[derive(BorshSerialize)]
pub struct MatchResult {
    pub rfq_id: u64,
    pub maker: String,
    pub terms_hash: String,
    pub class: u8,
    pub expires_at_ms: u64,
    pub bond: u128,
    pub trader_inner: Option<String>,
    pub owner_key: Option<String>,
    pub hedge: Option<HedgeSpec>,
    pub maker_sig: Vec<u8>,
}

impl MatchResult {
    pub fn new(rfq_id: u64, q: &Quote, req: &Request, terms_hash: &[u8; 32]) -> Self {
        Self {
            rfq_id,
            maker: q.maker.clone(),
            terms_hash: format!("0x{}", hex::encode(terms_hash)),
            class: if req.kind == "spot" { 0 } else { 1 },
            expires_at_ms: q.expires_at_ms,
            bond: q.bond,
            trader_inner: Some(req.trader.refund_inner.clone()),
            owner_key: Some(req.trader.owner_key.clone()),
            hedge: q.hedge.as_ref().map(|h| HedgeSpec {
                asset: h.asset,
                coin: h.coin.clone(),
                is_buy: h.is_buy,
                size: h.size.clone(),
                limit_px: h.limit_px.clone(),
                deadline_ms: h.deadline_ms,
                testnet: h.testnet,
            }),
            maker_sig: q.signature_bytes().map(|s| s.to_vec()).unwrap_or_default(),
        }
    }

    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut b = b"hushd.match.v1".to_vec();
        b.extend_from_slice(&borsh::to_vec(self).expect("borsh"));
        b
    }

    pub fn to_json(&self) -> Value {
        use base64::Engine;
        json!({
            "rfq_id": self.rfq_id.to_string(),
            "maker": self.maker,
            "terms_hash": self.terms_hash,
            "class": CLASS_NAMES[self.class as usize],
            "expires_at_ms": self.expires_at_ms.to_string(),
            "bond": self.bond.to_string(),
            "trader_inner": self.trader_inner,
            "owner_key": self.owner_key,
            "hedge": self.hedge.as_ref().map(|h| json!({ "asset": h.asset, "coin": h.coin, "is_buy": h.is_buy, "size": h.size,
                "limit_px": h.limit_px, "deadline_ms": h.deadline_ms, "testnet": h.testnet })),
            "maker_sig": base64::engine::general_purpose::STANDARD.encode(&self.maker_sig),
        })
    }
}

// ---------- hushd1 addresses (bech32m of pk ‖ X25519 key) ----------

const CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

fn polymod(values: &[u8]) -> u32 {
    let generator = [0x3b6a57b2u32, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let mut chk = 1u32;
    for v in values {
        let b = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ (*v as u32);
        for (i, g) in generator.iter().enumerate() {
            if (b >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

/// The X25519 key inside a hushd1… address, after checking its bech32m checksum.
pub fn address_enc_key(addr: &str) -> Option<[u8; 32]> {
    let addr = addr.to_lowercase();
    let pos = addr.rfind('1')?;
    let (hrp, data) = (&addr[..pos], &addr[pos + 1..]);
    if hrp != "hushd" || data.len() < 6 {
        return None;
    }
    let values: Vec<u8> = data.bytes().map(|c| CHARSET.iter().position(|x| *x == c).map(|p| p as u8)).collect::<Option<_>>()?;
    let mut check: Vec<u8> = hrp.bytes().map(|c| c >> 5).collect();
    check.push(0);
    check.extend(hrp.bytes().map(|c| c & 31));
    check.extend_from_slice(&values);
    if polymod(&check) != 0x2bc830a3 {
        return None;
    }
    let words = &values[..values.len() - 6];
    let mut bytes = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for w in words {
        acc = (acc << 5) | *w as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits) as u8);
        }
    }
    if bytes.len() != 64 {
        return None;
    }
    bytes[32..].try_into().ok()
}

fn bs58_decode(s: &str) -> Option<Vec<u8>> {
    const ALPHA: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut out: Vec<u8> = vec![0];
    for c in s.bytes() {
        let mut carry = ALPHA.iter().position(|x| *x == c)? as u32;
        for b in out.iter_mut().rev() {
            let v = (*b as u32) * 58 + carry;
            *b = (v & 0xff) as u8;
            carry = v >> 8;
        }
        while carry > 0 {
            out.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|c| *c == b'1').count();
    let first = out.iter().position(|b| *b != 0).unwrap_or(out.len());
    let mut res = vec![0u8; zeros];
    res.extend_from_slice(&out[first..]);
    Some(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_base58_keys() {
        // "ed25519:11111111111111111111111111111111" is the all-zero key
        assert_eq!(bs58_decode("11111111111111111111111111111111").unwrap(), vec![0u8; 32]);
        assert_eq!(bs58_decode("2").unwrap(), vec![1u8]);
    }
}
