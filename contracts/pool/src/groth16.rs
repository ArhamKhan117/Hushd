//! Groth16 verification on BN254 with NEAR's alt_bn128 host functions.
//!
//! Checks e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) = 1 with
//! vk_x = IC[0] + Σ input_i · IC[i+1]. Points use the host functions' layout:
//! G1 = x ‖ y, G2 = x.c0 ‖ x.c1 ‖ y.c0 ‖ y.c1, every coordinate 32 bytes
//! little-endian. Verifying keys and proofs arrive in snarkjs's JSON shape.

use crate::field::{self, Field};
use near_sdk::env;
use near_sdk::near;

pub type G1 = [u8; 64];
pub type G2 = [u8; 128];

/// BN254 base field modulus q, little-endian (for negating A).
const Q_LE: [u8; 32] = [
    0x47, 0xfd, 0x7c, 0xd8, 0x16, 0x8c, 0x20, 0x3c, 0x8d, 0xca, 0x71, 0x68, 0x91, 0x6a, 0x81, 0x97,
    0x5d, 0x58, 0x81, 0x81, 0xb6, 0x45, 0x50, 0xb8, 0x29, 0xa0, 0x31, 0xe1, 0x72, 0x4e, 0x64, 0x30,
];

/// A proof as snarkjs prints it: decimal coordinates, projective with z = 1.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Proof {
    pub pi_a: Vec<String>,
    pub pi_b: Vec<Vec<String>>,
    pub pi_c: Vec<String>,
}

pub struct VerifyingKey {
    pub alpha: G1,
    pub beta: G2,
    pub gamma: G2,
    pub delta: G2,
    pub ic: Vec<G1>,
}

fn coord(s: &str) -> Option<[u8; 32]> {
    // Base field coordinates are below q < 2^254; parse as a 256-bit number.
    let be = parse_u256(s)?;
    let mut le = be;
    le.reverse();
    (lt_le(&le, &Q_LE)).then_some(le)
}

fn parse_u256(s: &str) -> Option<[u8; 32]> {
    if s.is_empty() || s.len() > 78 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut out = [0u8; 32];
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

/// a < b for little-endian 256-bit numbers.
fn lt_le(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
    }
    false
}

pub fn g1(p: &[String]) -> Option<G1> {
    if p.len() < 2 || p.get(2).is_some_and(|z| z != "1") {
        return None;
    }
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&coord(&p[0])?);
    out[32..].copy_from_slice(&coord(&p[1])?);
    Some(out)
}

pub fn g2(p: &[Vec<String>]) -> Option<G2> {
    if p.len() < 2 || p[0].len() != 2 || p[1].len() != 2 {
        return None;
    }
    if let Some(z) = p.get(2)
        && (z.len() != 2 || z[0] != "1" || z[1] != "0")
    {
        return None;
    }
    let mut out = [0u8; 128];
    out[..32].copy_from_slice(&coord(&p[0][0])?);
    out[32..64].copy_from_slice(&coord(&p[0][1])?);
    out[64..96].copy_from_slice(&coord(&p[1][0])?);
    out[96..].copy_from_slice(&coord(&p[1][1])?);
    Some(out)
}

/// -P for a G1 point: (x, q - y), and the point at infinity stays put.
fn negate(p: &G1) -> G1 {
    let mut out = *p;
    let y: [u8; 32] = p[32..].try_into().unwrap();
    if y == [0u8; 32] {
        return out;
    }
    let mut borrow = 0i16;
    for i in 0..32 {
        let v = Q_LE[i] as i16 - y[i] as i16 - borrow;
        if v < 0 {
            out[32 + i] = (v + 256) as u8;
            borrow = 1;
        } else {
            out[32 + i] = v as u8;
            borrow = 0;
        }
    }
    out
}

/// Verify a proof against public inputs (each a canonical field element).
pub fn verify(vk: &VerifyingKey, proof: &Proof, inputs: &[Field]) -> bool {
    if inputs.len() + 1 != vk.ic.len() {
        return false;
    }
    let (Some(a), Some(b), Some(c)) = (g1(&proof.pi_a), g2(&proof.pi_b), g1(&proof.pi_c)) else {
        return false;
    };
    if inputs.iter().any(|x| !field::is_canonical(x)) {
        return false;
    }

    // vk_x = IC[0] + Σ input_i · IC[i+1]
    let mut msm = Vec::with_capacity(inputs.len() * 96);
    for (i, x) in inputs.iter().enumerate() {
        msm.extend_from_slice(&vk.ic[i + 1]);
        msm.extend_from_slice(&field::to_le(x));
    }
    let acc = env::alt_bn128_g1_multiexp(&msm);
    let mut sum = Vec::with_capacity(130);
    sum.push(0);
    sum.extend_from_slice(&vk.ic[0]);
    sum.push(0);
    sum.extend_from_slice(&acc);
    let vk_x = env::alt_bn128_g1_sum(&sum);

    let mut pairs = Vec::with_capacity(4 * 192);
    pairs.extend_from_slice(&negate(&a));
    pairs.extend_from_slice(&b);
    pairs.extend_from_slice(&vk.alpha);
    pairs.extend_from_slice(&vk.beta);
    pairs.extend_from_slice(&vk_x);
    pairs.extend_from_slice(&vk.gamma);
    pairs.extend_from_slice(&c);
    pairs.extend_from_slice(&vk.delta);
    env::alt_bn128_pairing_check(&pairs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negating_twice_is_identity() {
        let mut p = [0u8; 64];
        p[0] = 1;
        p[32] = 2;
        assert_eq!(negate(&negate(&p)), p);
        let inf = [0u8; 64];
        assert_eq!(negate(&inf), inf);
    }

    #[test]
    fn coordinates_must_be_below_q() {
        assert!(coord("21888242871839275222246405745257275088696311157297823662689037894645226208583").is_none());
        assert!(coord("21888242871839275222246405745257275088696311157297823662689037894645226208582").is_some());
    }
}
