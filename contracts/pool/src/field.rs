//! BN254 scalar field elements as they cross the contract boundary.
//!
//! Inside the contract a field element is `[u8; 32]`, big-endian, always below the
//! scalar field modulus r. On the JSON API it is a decimal string (what snarkjs
//! prints) or a `0x` hex string; views return `0x` hex.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use near_sdk::env;
use near_sdk::serde::{Deserialize, Deserializer, Serialize, Serializer};

pub type Field = [u8; 32];

pub const ZERO: Field = [0u8; 32];

/// r, big-endian.
pub const MODULUS: Field = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

pub fn is_canonical(x: &Field) -> bool {
    x < &MODULUS
}

pub fn to_fr(x: &Field) -> Fr {
    Fr::from_be_bytes_mod_order(x)
}

pub fn from_fr(x: &Fr) -> Field {
    let bytes = x.into_bigint().to_bytes_be();
    let mut out = ZERO;
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

/// Little-endian bytes, the layout NEAR's alt_bn128 host functions read.
pub fn to_le(x: &Field) -> [u8; 32] {
    let mut out = *x;
    out.reverse();
    out
}

pub fn from_u128(v: u128) -> Field {
    let mut out = ZERO;
    out[16..].copy_from_slice(&v.to_be_bytes());
    out
}

/// sha256 of the input with the top byte cleared: a uniformly spread 248-bit value,
/// always a canonical field element. Used for asset ids, ext hashes and contexts.
pub fn hash_to_field(data: &[u8]) -> Field {
    let mut h: Field = env::sha256_array(data);
    h[0] = 0;
    h
}

/// The field id of a NEP-141 token: sha256("hushd.asset.v1:" + account id), top byte cleared.
pub fn asset_field(token: &str) -> Field {
    let mut data = b"hushd.asset.v1:".to_vec();
    data.extend_from_slice(token.as_bytes());
    hash_to_field(&data)
}

pub fn parse(s: &str) -> Option<Field> {
    let out = if let Some(hex_part) = s.strip_prefix("0x") {
        if hex_part.is_empty() || hex_part.len() > 64 {
            return None;
        }
        let padded = format!("{hex_part:0>64}");
        let mut out = ZERO;
        hex::decode_to_slice(padded, &mut out).ok()?;
        out
    } else {
        parse_decimal(s)?
    };
    is_canonical(&out).then_some(out)
}

fn parse_decimal(s: &str) -> Option<Field> {
    if s.is_empty() || s.len() > 78 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // big-endian base-256 accumulator: out = out * 10 + digit
    let mut out = ZERO;
    for b in s.bytes() {
        let mut carry = (b - b'0') as u32;
        for byte in out.iter_mut().rev() {
            let v = (*byte as u32) * 10 + carry;
            *byte = (v & 0xff) as u8;
            carry = v >> 8;
        }
        if carry != 0 {
            return None;
        }
    }
    Some(out)
}

pub fn to_hex(x: &Field) -> String {
    format!("0x{}", hex::encode(x))
}

/// A field element on the JSON API: parsed from decimal or hex, printed as hex.
#[derive(Clone, Copy, Debug, PartialEq, Eq, near_sdk::NearSchema)]
#[abi(json)]
pub struct FieldStr(#[schemars(with = "String")] pub Field);

impl Serialize for FieldStr {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&to_hex(&self.0))
    }
}

impl<'de> Deserialize<'de> for FieldStr {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        parse(&s)
            .map(FieldStr)
            .ok_or_else(|| near_sdk::serde::de::Error::custom("not a field element below r"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_and_hex_agree() {
        let d = parse("12345678901234567890123456789").unwrap();
        let h = parse("0x27e41b3246bec9b16e398115").unwrap();
        assert_eq!(d, h);
    }

    #[test]
    fn rejects_modulus_and_garbage() {
        assert!(parse("21888242871839275222246405745257275088548364400416034343698204186575808495617").is_none());
        assert!(parse("21888242871839275222246405745257275088548364400416034343698204186575808495616").is_some());
        assert!(parse("12a").is_none());
        assert!(parse("").is_none());
        assert!(parse("0x").is_none());
    }

    #[test]
    fn fr_round_trip() {
        let x = parse("987654321").unwrap();
        assert_eq!(from_fr(&to_fr(&x)), x);
    }
}
