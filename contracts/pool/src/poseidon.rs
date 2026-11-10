//! Poseidon over BN254 with circomlib's parameters (x^5, 8 full rounds), the same
//! hash the circuits use. Only widths 3 (two inputs: the tree) and 4 (three inputs:
//! note commitments and the volume list) are compiled in.

use crate::field::{from_fr, to_fr, Field};
use crate::poseidon_constants::{ARK_3, ARK_4, MDS_3, MDS_4, PARTIAL_ROUNDS_3, PARTIAL_ROUNDS_4};
use ark_bn254::Fr;
use ark_ff::{Field as _, Zero};

const FULL_ROUNDS: usize = 8;

#[inline(always)]
fn sbox(x: Fr) -> Fr {
    let x2 = x.square();
    x2.square() * x
}

fn permute<const W: usize>(mut state: [Fr; W], ark: &[Fr], mds: &[[Fr; W]; W], partial: usize) -> Fr {
    let half = FULL_ROUNDS / 2;
    for round in 0..FULL_ROUNDS + partial {
        for (i, s) in state.iter_mut().enumerate() {
            *s += ark[round * W + i];
        }
        if round < half || round >= half + partial {
            for s in state.iter_mut() {
                *s = sbox(*s);
            }
        } else {
            state[0] = sbox(state[0]);
        }
        let mut next = [Fr::zero(); W];
        for (i, row) in mds.iter().enumerate() {
            let mut acc = Fr::zero();
            for (m, s) in row.iter().zip(state.iter()) {
                acc += *m * s;
            }
            next[i] = acc;
        }
        state = next;
    }
    state[0]
}

pub fn hash2(a: &Field, b: &Field) -> Field {
    from_fr(&permute([Fr::zero(), to_fr(a), to_fr(b)], &ARK_3, &MDS_3, PARTIAL_ROUNDS_3))
}

pub fn hash3(a: &Field, b: &Field, c: &Field) -> Field {
    from_fr(&permute([Fr::zero(), to_fr(a), to_fr(b), to_fr(c)], &ARK_4, &MDS_4, PARTIAL_ROUNDS_4))
}

/// What the tree and the pool hash with: a unit type, since the hash holds no state.
#[derive(Default)]
pub struct Hasher;

impl Hasher {
    pub fn new() -> Self {
        Self
    }
    pub fn hash2(&mut self, a: &Field, b: &Field) -> Field {
        hash2(a, b)
    }
    pub fn hash3(&mut self, a: &Field, b: &Field, c: &Field) -> Field {
        hash3(a, b, c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::{from_u128, parse};
    use light_poseidon::{Poseidon, PoseidonHasher};

    // circomlibjs: poseidon([1, 2]) and poseidon([1, 2, 3]).
    #[test]
    fn matches_circomlib() {
        let one = parse("1").unwrap();
        let two = parse("2").unwrap();
        let three = parse("3").unwrap();
        assert_eq!(
            hash2(&one, &two),
            parse("7853200120776062878684798364095072458815029376092732009249414926327459813530").unwrap()
        );
        assert_eq!(
            hash3(&one, &two, &three),
            parse("6542985608222806190361240322586112750744169038454362455181422643027100751666").unwrap()
        );
    }

    #[test]
    fn matches_the_reference_implementation() {
        let mut two = Poseidon::<Fr>::new_circom(2).unwrap();
        let mut three = Poseidon::<Fr>::new_circom(3).unwrap();
        for i in 0..20u128 {
            let a = from_u128(i * 7919 + 3);
            let b = from_u128(i * 104729 + 11);
            let c = from_u128(i * 1299709 + 17);
            assert_eq!(hash2(&a, &b), from_fr(&two.hash(&[to_fr(&a), to_fr(&b)]).unwrap()));
            assert_eq!(hash3(&a, &b, &c), from_fr(&three.hash(&[to_fr(&a), to_fr(&b), to_fr(&c)]).unwrap()));
        }
    }
}
