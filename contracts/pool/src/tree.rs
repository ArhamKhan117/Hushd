//! Incremental Poseidon Merkle tree with a ring of recent roots.
//!
//! parent = Poseidon(left, right); empty leaves are 0 and an empty subtree of
//! height h is zeros[h] = Poseidon(zeros[h-1], zeros[h-1]). Spends may name any of
//! the last `ROOT_HISTORY` roots, so a proof made a few blocks ago still lands.
//! Every root is also logged under its own storage key (`was_root`), so a disclosure
//! proven against an old root still checks out; its notes are checked unspent live.
//!
//! There are no tree epochs: once all 2^20 leaves are used the pool takes no new
//! notes (spends of existing notes still need a free pair of leaves). A full pool is
//! replaced by a new deployment; `min_deposit` keeps dust from filling it early.

use crate::field::{Field, ZERO};
use crate::poseidon::Hasher;
use near_sdk::{env, near};

pub const LEVELS: usize = 20;
pub const ROOT_HISTORY: usize = 100;

#[near(serializers = [borsh])]
pub struct Tree {
    pub next_index: u64,
    filled: Vec<Field>,
    zeros: Vec<Field>,
    roots: Vec<Field>,
    current: u32,
}

impl Tree {
    pub fn new(h: &mut Hasher) -> Self {
        let mut zeros = Vec::with_capacity(LEVELS + 1);
        zeros.push(ZERO);
        for i in 0..LEVELS {
            let z = zeros[i];
            zeros.push(h.hash2(&z, &z));
        }
        let mut roots = vec![ZERO; ROOT_HISTORY];
        roots[0] = zeros[LEVELS];
        Self { next_index: 0, filled: zeros[..LEVELS].to_vec(), zeros, roots, current: 0 }
    }

    pub fn root(&self) -> Field {
        self.roots[self.current as usize]
    }

    pub fn capacity() -> u64 {
        1u64 << LEVELS
    }

    pub fn is_known_root(&self, root: &Field) -> bool {
        root != &ZERO && self.roots.iter().any(|r| r == root)
    }

    pub fn recent_roots(&self) -> Vec<Field> {
        let n = ROOT_HISTORY;
        (0..n)
            .map(|i| self.roots[(self.current as usize + n - i) % n])
            .filter(|r| r != &ZERO)
            .collect()
    }

    /// Insert one leaf; returns its index.
    pub fn insert(&mut self, leaf: Field, h: &mut Hasher) -> u64 {
        let index = self.next_index;
        assert!(index < Self::capacity(), "The tree is full");
        let mut node = leaf;
        let mut i = index;
        for level in 0..LEVELS {
            if i.is_multiple_of(2) {
                self.filled[level] = node;
                node = h.hash2(&node, &self.zeros[level]);
            } else {
                node = h.hash2(&self.filled[level], &node);
            }
            i /= 2;
        }
        self.push_root(node);
        self.next_index = index + 1;
        index
    }

    /// Insert two leaves; when they land as siblings (even index) the pair costs one
    /// path of hashes instead of two. Returns the index of the first.
    pub fn insert_pair(&mut self, left: Field, right: Field, h: &mut Hasher) -> u64 {
        let index = self.next_index;
        if index % 2 == 1 {
            self.insert(left, h);
            self.insert(right, h);
            return index;
        }
        assert!(index + 2 <= Self::capacity(), "The tree is full");
        self.filled[0] = left;
        let mut node = h.hash2(&left, &right);
        let mut i = index / 2;
        for level in 1..LEVELS {
            if i.is_multiple_of(2) {
                self.filled[level] = node;
                node = h.hash2(&node, &self.zeros[level]);
            } else {
                node = h.hash2(&self.filled[level], &node);
            }
            i /= 2;
        }
        self.push_root(node);
        self.next_index = index + 2;
        index
    }

    fn push_root(&mut self, root: Field) {
        self.current = ((self.current as usize + 1) % ROOT_HISTORY) as u32;
        self.roots[self.current as usize] = root;
        env::storage_write(&root_log_key(&root), &[1]);
    }
}

/// The storage key logging one root: outside the contract's own state, so it needs no migration.
fn root_log_key(root: &Field) -> Vec<u8> {
    [b"root:".as_slice(), root.as_slice()].concat()
}

/// Whether this root is in the log (every root the tree records goes there).
pub fn was_root(root: &Field) -> bool {
    root != &ZERO && env::storage_has_key(&root_log_key(root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::from_u128;

    /// Rebuild the root from every leaf, the slow way.
    fn full_root(leaves: &[Field], h: &mut Hasher) -> Field {
        let t = Tree::new(h);
        let mut level: Vec<Field> = leaves.to_vec();
        for depth in 0..LEVELS {
            if level.len() % 2 == 1 {
                level.push(t.zeros[depth]);
            }
            if level.is_empty() {
                return t.zeros[LEVELS];
            }
            level = level.chunks(2).map(|p| h.hash2(&p[0], &p[1])).collect();
        }
        level[0]
    }

    #[test]
    fn single_and_pair_inserts_match_the_full_tree() {
        let mut h = Hasher::new();
        let mut t = Tree::new(&mut h);
        let leaves: Vec<Field> = (1..=7u128).map(from_u128).collect();
        t.insert(leaves[0], &mut h);
        t.insert_pair(leaves[1], leaves[2], &mut h); // odd start: two singles
        t.insert_pair(leaves[3], leaves[4], &mut h); // even start: one pair
        t.insert(leaves[5], &mut h);
        t.insert(leaves[6], &mut h);
        assert_eq!(t.next_index, 7);
        assert_eq!(t.root(), full_root(&leaves, &mut h));
        assert!(t.is_known_root(&full_root(&leaves[..5], &mut h)));
        assert!(!t.is_known_root(&ZERO));
    }

    #[test]
    fn root_history_rolls() {
        let mut h = Hasher::new();
        let mut t = Tree::new(&mut h);
        let first = t.root();
        for i in 0..(ROOT_HISTORY as u128) {
            t.insert(from_u128(i + 1), &mut h);
        }
        assert!(!t.is_known_root(&first), "the empty root has rolled out");
        assert_eq!(t.recent_roots().len(), ROOT_HISTORY);
    }
}
