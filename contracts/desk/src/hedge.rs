//! The Hyperliquid hedge leg of a package: the exact order the desk lets the MPC sign.
//!
//! Hyperliquid signs exchange actions as an EIP-712 "Agent" message whose
//! `connectionId` is keccak256(msgpack(action) ‖ nonce (u64 BE) ‖ 0x00 for no vault).
//! The desk rebuilds that digest on chain from the deal's own hedge spec, so the
//! per-deal address controlled through Chain Signatures can only ever sign the IOC
//! order the package named, never a transfer or a different trade.

use near_sdk::env;
use near_sdk::near;

/// What the package asked for on Hyperliquid. Prices and sizes are already in
/// Hyperliquid's wire format (decimal strings, trailing zeros removed).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct HedgeSpec {
    /// Hyperliquid asset index (perps), e.g. the index of NEAR.
    pub asset: u32,
    /// Human name for the asset, for receipts and the app.
    pub coin: String,
    pub is_buy: bool,
    /// Order size in the asset's units, wire format.
    pub size: String,
    /// Worst acceptable price, wire format; the order is IOC at this limit.
    pub limit_px: String,
    /// The leg must be filled by then or the maker's bond is slashed.
    pub deadline_ms: u64,
    /// Hyperliquid testnet ("b") or mainnet ("a").
    pub testnet: bool,
}

pub fn valid_wire_decimal(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 24
        && s.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && s.bytes().filter(|b| *b == b'.').count() <= 1
        && !s.starts_with('.')
        && !s.ends_with('.')
        && !(s.contains('.') && s.ends_with('0'))
}

// ---------- msgpack, just enough for an order action ----------

fn str_(out: &mut Vec<u8>, s: &str) {
    let b = s.as_bytes();
    if b.len() < 32 {
        out.push(0xa0 | b.len() as u8);
    } else {
        out.push(0xd9);
        out.push(b.len() as u8);
    }
    out.extend_from_slice(b);
}

fn uint(out: &mut Vec<u8>, v: u64) {
    if v < 0x80 {
        out.push(v as u8);
    } else if v <= 0xff {
        out.extend_from_slice(&[0xcc, v as u8]);
    } else if v <= 0xffff {
        out.push(0xcd);
        out.extend_from_slice(&(v as u16).to_be_bytes());
    } else if v <= 0xffff_ffff {
        out.push(0xce);
        out.extend_from_slice(&(v as u32).to_be_bytes());
    } else {
        out.push(0xcf);
        out.extend_from_slice(&v.to_be_bytes());
    }
}

fn bool_(out: &mut Vec<u8>, b: bool) {
    out.push(if b { 0xc3 } else { 0xc2 });
}

/// msgpack of `{"type":"order","orders":[{"a","b","p","s","r","t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"}`,
/// keys in that order, as Hyperliquid's own clients pack it.
pub fn order_action(asset: u32, is_buy: bool, px: &str, sz: &str, reduce_only: bool) -> Vec<u8> {
    let mut o = Vec::with_capacity(96);
    o.push(0x83);
    str_(&mut o, "type");
    str_(&mut o, "order");
    str_(&mut o, "orders");
    o.push(0x91);
    o.push(0x86);
    str_(&mut o, "a");
    uint(&mut o, asset as u64);
    str_(&mut o, "b");
    bool_(&mut o, is_buy);
    str_(&mut o, "p");
    str_(&mut o, px);
    str_(&mut o, "s");
    str_(&mut o, sz);
    str_(&mut o, "r");
    bool_(&mut o, reduce_only);
    str_(&mut o, "t");
    o.push(0x81);
    str_(&mut o, "limit");
    o.push(0x81);
    str_(&mut o, "tif");
    str_(&mut o, "Ioc");
    str_(&mut o, "grouping");
    str_(&mut o, "na");
    o
}

/// keccak256(action ‖ nonce BE ‖ 0x00): the action hash Hyperliquid calls connectionId.
pub fn connection_id(action: &[u8], nonce: u64) -> [u8; 32] {
    let mut data = action.to_vec();
    data.extend_from_slice(&nonce.to_be_bytes());
    data.push(0x00);
    env::keccak256_array(&data)
}

/// The EIP-712 digest of `Agent { source, connectionId }` under Hyperliquid's
/// "Exchange" domain (version "1", chain id 1337, zero verifying contract).
pub fn agent_digest(connection_id: [u8; 32], testnet: bool) -> [u8; 32] {
    let k = |b: &[u8]| env::keccak256_array(b);
    let domain_type = k(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    let mut chain_id = [0u8; 32];
    chain_id[30..].copy_from_slice(&1337u16.to_be_bytes());
    let mut domain = Vec::with_capacity(160);
    domain.extend_from_slice(&domain_type);
    domain.extend_from_slice(&k(b"Exchange"));
    domain.extend_from_slice(&k(b"1"));
    domain.extend_from_slice(&chain_id);
    domain.extend_from_slice(&[0u8; 32]);
    let domain_separator = k(&domain);

    let agent_type = k(b"Agent(string source,bytes32 connectionId)");
    let mut msg = Vec::with_capacity(96);
    msg.extend_from_slice(&agent_type);
    msg.extend_from_slice(&k(if testnet { b"b" } else { b"a" }));
    msg.extend_from_slice(&connection_id);
    let struct_hash = k(&msg);

    let mut digest = vec![0x19, 0x01];
    digest.extend_from_slice(&domain_separator);
    digest.extend_from_slice(&struct_hash);
    k(&digest)
}

/// The digest the MPC signs for the deal's opening order (or the reduce-only close).
pub fn order_digest(spec: &HedgeSpec, nonce: u64, close: bool) -> [u8; 32] {
    let is_buy = if close { !spec.is_buy } else { spec.is_buy };
    let action = order_action(spec.asset, is_buy, &spec.limit_px, &spec.size, close);
    agent_digest(connection_id(&action, nonce), spec.testnet)
}

/// sha256 of the spec's borsh bytes (32 zero bytes for no hedge): what a maker's consent
/// commits to, so the hedge leg it bonds is exactly the one it signed.
pub fn spec_hash(spec: Option<&HedgeSpec>) -> [u8; 32] {
    spec.map(|s| env::sha256_array(near_sdk::borsh::to_vec(s).expect("borsh"))).unwrap_or([0u8; 32])
}

/// Chain Signatures derivation path of a deal's own Hyperliquid address: one per deal, approved
/// as an agent of the maker's account, so its orders trade for the maker (and link to it).
pub fn derivation_path(deal_id: u64) -> String {
    format!("hushd/hedge/{deal_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_an_order_like_the_reference_clients() {
        // msgpack.packb({"type":"order","orders":[{"a":4,"b":True,"p":"1100","s":"0.2","r":False,
        //   "t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"}) from Python's msgpack.
        let expected = "83a474797065a56f72646572a66f72646572739186a161\
                        04a162c3a170a431313030a173a3302e32a172c2a174\
                        81a56c696d697481a3746966a3496f63a867726f7570\
                        696e67a26e61";
        assert_eq!(hex::encode(order_action(4, true, "1100", "0.2", false)), expected);
    }

    #[test]
    fn digests_match_the_reference_signer() {
        // eth_account.encode_typed_data over the same action, nonce 1700000000000.
        let action = order_action(4, true, "1100", "0.2", false);
        let cid = connection_id(&action, 1_700_000_000_000);
        assert_eq!(hex::encode(cid), "a16a54692ebc30f57a4abe9b8087a459a219162764d4d434c63ee169b845cad9");
        assert_eq!(hex::encode(agent_digest(cid, false)), "9c46bc1e9ada01a200c6cde8a8037564c8d96eeacf757350fd537ea9643d2aea");
        assert_eq!(hex::encode(agent_digest(cid, true)), "3472da4352bcc31306c8a5bc318a8b9d43d117479b8ee9bf44e6311c92ddbd48");
    }

    #[test]
    fn wire_decimals() {
        assert!(valid_wire_decimal("1100"));
        assert!(valid_wire_decimal("0.25"));
        assert!(!valid_wire_decimal("0.250"));
        assert!(!valid_wire_decimal("1e5"));
        assert!(!valid_wire_decimal(".5"));
        assert!(!valid_wire_decimal(""));
    }
}
