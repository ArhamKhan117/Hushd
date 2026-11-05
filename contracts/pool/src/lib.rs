//! Hushd pool: a shielded pool for NEP-141 tokens on NEAR.
//!
//! - Shield: `ft_transfer_call` to the pool with `{"inner": "<field>"}`; the pool
//!   computes the note commitment from the tokens it actually received.
//! - `transact`: spend up to two notes into two new ones, optionally cashing out
//!   with change; one Groth16 proof checked on chain.
//! - `settle_swap`: two counterparties' proofs, one call, applied together or not
//!   at all; only the desk may call it, for a deal it matched.
//! - `verify_disclosure`: a view that checks a proof made for one named reader
//!   (payment or settlement made, funds held, OTC volume) against chain state.
//!
//! No account can move pooled funds: there is no admin withdraw. Rule changes
//! (limits, assets, the desk) wait out a timelock; the owner can only pause new
//! deposits, never cash outs.

mod events;
pub mod field;
pub mod groth16;
pub mod poseidon;
mod poseidon_constants;
pub mod tree;
mod vk;

use field::{Field, FieldStr, ZERO};
use groth16::Proof;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue,
};
use poseidon::Hasher;
use tree::Tree;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
/// A refund inserts a note (about 28 Tgas); 50 leaves room so a refund can never run out.
const GAS_ON_PAYOUT: Gas = Gas::from_tgas(50);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Amounts are below 2^128 in the circuits; u128 already guarantees it.
const MAX_MEMO: usize = 256;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Spends,
    Assets,
    TokenByField,
    Pending,
    Unclaimed,
    Leaves,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    pub per_deposit: U128,
    pub total: U128,
}

#[near(serializers = [borsh])]
pub struct Asset {
    pub field: Field,
    pub limits: Limits,
    /// Tokens the pool holds for notes of this asset.
    pub held: u128,
}

#[near(serializers = [json])]
pub struct AssetView {
    pub token: AccountId,
    pub field: FieldStr,
    pub limits: Limits,
    pub held: U128,
}

#[near(serializers = [json])]
pub struct AssetInit {
    pub token: AccountId,
    pub limits: Limits,
}

/// What a nullifier was spent in: the outputs of that call, and the deal when it
/// was a leg of an OTC settlement. Readers of disclosure proofs check against it.
#[near(serializers = [borsh])]
pub struct Spend {
    pub outputs: [Field; 2],
    pub deal: Option<u64>,
    pub block: u64,
}

#[near(serializers = [json])]
pub struct SpendView {
    pub outputs: [FieldStr; 2],
    pub deal_id: Option<U64>,
    pub block_height: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    AddAsset { token: AccountId, limits: Limits },
    SetLimits { token: AccountId, limits: Limits },
    SetDesk { desk: AccountId },
    SetOwner { owner: AccountId },
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Pending {
    pub change: Change,
    pub apply_after_ns: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Stats {
    pub shields: u64,
    pub transfers: u64,
    pub cash_outs: u64,
    pub swaps: u64,
    pub refunds: u64,
}

/// Data the proof binds through `extHash` so a relayer cannot change it.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default)]
pub struct ExtData {
    pub recipient: Option<AccountId>,
    pub relayer: Option<AccountId>,
    #[serde(default)]
    pub fee: U128,
    /// `inner` of a note the pool inserts if the cash out cannot be paid.
    pub refund_inner: Option<FieldStr>,
    pub memo: Option<String>,
}

impl ExtData {
    /// "hushd.ext.v1" ‖ len ‖ recipient ‖ len ‖ relayer ‖ fee (u128 LE) ‖ refund_inner (32, BE)
    /// ‖ memo length (u32 LE) ‖ memo, hashed with sha256 and cut to 248 bits.
    pub fn hash(&self) -> Field {
        let mut b = b"hushd.ext.v1".to_vec();
        for a in [&self.recipient, &self.relayer] {
            let s = a.as_ref().map(|a| a.as_str()).unwrap_or("");
            b.push(s.len() as u8);
            b.extend_from_slice(s.as_bytes());
        }
        b.extend_from_slice(&self.fee.0.to_le_bytes());
        b.extend_from_slice(&self.refund_inner.map(|f| f.0).unwrap_or(ZERO));
        let memo = self.memo.as_deref().unwrap_or("");
        b.extend_from_slice(&(memo.len() as u32).to_le_bytes());
        b.extend_from_slice(memo.as_bytes());
        field::hash_to_field(&b)
    }
}

/// The binding both legs of a swap share: "hushd.swap.v1" ‖ deal id (u64 LE) ‖ the
/// four output commitments (32 bytes BE each, leg A then leg B).
pub fn swap_ext_hash(deal_id: u64, a: &[Field; 2], b: &[Field; 2]) -> Field {
    let mut buf = b"hushd.swap.v1".to_vec();
    buf.extend_from_slice(&deal_id.to_le_bytes());
    for c in a.iter().chain(b.iter()) {
        buf.extend_from_slice(c);
    }
    field::hash_to_field(&buf)
}

#[near(serializers = [json])]
pub struct TransactArgs {
    pub root: FieldStr,
    pub nullifiers: [FieldStr; 2],
    pub commitments: [FieldStr; 2],
    #[serde(default)]
    pub public_amount: U128,
    pub token: Option<AccountId>,
    #[serde(default)]
    pub ext: ExtData,
}

#[near(serializers = [json])]
pub struct SwapLeg {
    pub proof: Proof,
    pub root: FieldStr,
    pub nullifiers: [FieldStr; 2],
    pub commitments: [FieldStr; 2],
}

#[near(serializers = [json])]
pub struct Inserted {
    pub leaf_index: U64,
    pub root: FieldStr,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ShieldMsg {
    inner: FieldStr,
}

#[near(serializers = [json])]
pub struct DisclosureCheck {
    /// The Groth16 proof verifies against the reader-proof key for its kind.
    pub proof_valid: bool,
    /// Every chain fact the proof relies on holds right now.
    pub chain_valid: bool,
    pub problems: Vec<String>,
    /// The token the proof is about, when the pool lists it.
    pub token: Option<AccountId>,
    /// Desk deals the proven payments settled, in order (receipt and volume).
    pub deal_ids: Vec<Option<U64>>,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait SelfCallbacks {
    fn on_payout(
        &mut self,
        token: AccountId,
        recipient: AccountId,
        amount: U128,
        relayer: Option<AccountId>,
        fee: U128,
        refund_inner: Option<FieldStr>,
    );
    fn on_claim(&mut self, token: AccountId, account: AccountId, amount: U128);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pool {
    owner: AccountId,
    desk: Option<AccountId>,
    timelock_ns: u64,
    deposits_paused: bool,
    tree: Tree,
    spends: LookupMap<Field, Spend>,
    assets: IterableMap<AccountId, Asset>,
    token_by_field: LookupMap<Field, AccountId>,
    pending: IterableMap<u64, Pending>,
    next_change: u64,
    unclaimed: LookupMap<(AccountId, AccountId), u128>,
    /// Every leaf in order, so any wallet can rebuild the tree from RPC alone.
    leaves: Vector<Field>,
    stats: Stats,
}

#[near]
impl Pool {
    #[init]
    pub fn new(owner_id: AccountId, desk_id: Option<AccountId>, timelock_ns: U64, assets: Vec<AssetInit>) -> Self {
        let mut h = Hasher::new();
        let mut pool = Self {
            owner: owner_id,
            desk: desk_id,
            timelock_ns: timelock_ns.0,
            deposits_paused: false,
            tree: Tree::new(&mut h),
            spends: LookupMap::new(Key::Spends),
            assets: IterableMap::new(Key::Assets),
            token_by_field: LookupMap::new(Key::TokenByField),
            pending: IterableMap::new(Key::Pending),
            next_change: 0,
            unclaimed: LookupMap::new(Key::Unclaimed),
            leaves: Vector::new(Key::Leaves),
            stats: Stats::default(),
        };
        for a in assets {
            pool.add_asset(a.token, a.limits);
        }
        pool
    }

    // ---------- private moves ----------

    /// Private send or cash out. The caller (normally the relayer) attaches NEAR for
    /// the storage of two spend records; what is not used comes back.
    #[payable]
    pub fn transact(&mut self, proof: Proof, args: TransactArgs) -> PromiseOrValue<Inserted> {
        let storage_before = env::storage_usage();
        let public_amount = args.public_amount.0;
        let ext = args.ext;
        if let Some(m) = &ext.memo {
            require!(m.len() <= MAX_MEMO, "Memo too long");
        }

        let token_field = if public_amount == 0 {
            require!(args.token.is_none() && ext.recipient.is_none(), "A private send names no token and no recipient");
            require!(ext.fee.0 == 0, "A private send carries no fee");
            ZERO
        } else {
            let token = args.token.as_ref().unwrap_or_else(|| env::panic_str("A cash out names its token"));
            require!(ext.recipient.is_some(), "A cash out names its recipient");
            require!(ext.fee.0 <= public_amount, "Fee above the amount");
            require!(ext.fee.0 == 0 || ext.relayer.is_some(), "A fee names its relayer");
            let asset = self.assets.get(token).unwrap_or_else(|| env::panic_str("Unknown token"));
            require!(asset.held >= public_amount, "The pool holds less of this token");
            asset.field
        };

        let [n0, n1] = args.nullifiers.map(|f| f.0);
        let [c0, c1] = args.commitments.map(|f| f.0);
        self.check_spendable(&args.root.0, &[n0, n1]);

        let inputs = [args.root.0, n0, n1, c0, c1, field::from_u128(public_amount), token_field, ext.hash()];
        require!(groth16::verify(&vk::joinsplit(), &proof, &inputs), "Invalid proof");

        let block = env::block_height();
        for n in [n0, n1] {
            self.spends.insert(n, Spend { outputs: [c0, c1], deal: None, block });
        }
        let mut h = Hasher::new();
        let leaf_index = self.insert_pair(c0, c1, &mut h);
        let root = self.tree.root();

        if public_amount == 0 {
            self.stats.transfers += 1;
        } else {
            self.stats.cash_outs += 1;
            let token = args.token.as_ref().unwrap();
            self.assets.get_mut(token).unwrap().held -= public_amount;
        }
        events::transact(events::Transact {
            nullifiers: [FieldStr(n0), FieldStr(n1)],
            commitments: [FieldStr(c0), FieldStr(c1)],
            leaf_index: U64(leaf_index),
            root: FieldStr(root),
            public_amount: U128(public_amount),
            token: args.token.as_ref(),
            recipient: ext.recipient.as_ref(),
        });
        self.settle_storage(storage_before);

        let inserted = Inserted { leaf_index: U64(leaf_index), root: FieldStr(root) };
        if public_amount == 0 {
            return PromiseOrValue::Value(inserted);
        }
        let token = args.token.unwrap();
        let recipient = ext.recipient.clone().unwrap();
        let to_recipient = public_amount - ext.fee.0;
        let mut payout = ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(recipient.clone(), U128(to_recipient), Some("Hushd cash out".into()));
        if ext.fee.0 > 0 {
            payout = payout.and(
                ext_ft::ext(token.clone())
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(GAS_FT_TRANSFER)
                    .ft_transfer(ext.relayer.clone().unwrap(), ext.fee, Some("Hushd relay fee".into())),
            );
        }
        let _ = payout.then(
            ext_self::ext(env::current_account_id()).with_static_gas(GAS_ON_PAYOUT).on_payout(
                token,
                recipient,
                U128(to_recipient),
                ext.relayer,
                ext.fee,
                ext.refund_inner,
            ),
        );
        PromiseOrValue::Value(inserted)
    }

    /// Both legs of a matched OTC deal in one call: both proofs must verify and both
    /// must bind this deal and all four outputs, or nothing is applied. Desk only.
    #[payable]
    pub fn settle_swap(&mut self, deal_id: U64, legs: [SwapLeg; 2]) -> Inserted {
        require!(Some(env::predecessor_account_id()) == self.desk, "Only the desk settles swaps");
        let storage_before = env::storage_usage();
        let [a, b] = legs;
        let a_out = a.commitments.map(|f| f.0);
        let b_out = b.commitments.map(|f| f.0);
        let binding = swap_ext_hash(deal_id.0, &a_out, &b_out);

        let nullifiers = [a.nullifiers[0].0, a.nullifiers[1].0, b.nullifiers[0].0, b.nullifiers[1].0];
        self.check_spendable(&a.root.0, &nullifiers[..2]);
        self.check_spendable(&b.root.0, &nullifiers[2..]);
        for i in 0..4 {
            for j in (i + 1)..4 {
                require!(nullifiers[i] != nullifiers[j], "A note appears twice");
            }
        }

        let key = vk::joinsplit();
        for (leg, out) in [(&a, &a_out), (&b, &b_out)] {
            let inputs = [leg.root.0, leg.nullifiers[0].0, leg.nullifiers[1].0, out[0], out[1], ZERO, ZERO, binding];
            require!(groth16::verify(&key, &leg.proof, &inputs), "Invalid proof");
        }

        let block = env::block_height();
        for (i, n) in nullifiers.iter().enumerate() {
            let outputs = if i < 2 { a_out } else { b_out };
            self.spends.insert(*n, Spend { outputs, deal: Some(deal_id.0), block });
        }
        let mut h = Hasher::new();
        let leaf_index = self.insert_pair(a_out[0], a_out[1], &mut h);
        self.insert_pair(b_out[0], b_out[1], &mut h);
        let root = self.tree.root();
        self.stats.swaps += 1;
        events::swap(events::Swap {
            deal_id,
            nullifiers: nullifiers.map(FieldStr),
            commitments: [a_out[0], a_out[1], b_out[0], b_out[1]].map(FieldStr),
            leaf_index: U64(leaf_index),
            root: FieldStr(root),
        });
        self.settle_storage(storage_before);
        Inserted { leaf_index: U64(leaf_index), root: FieldStr(root) }
    }

    #[private]
    pub fn on_payout(
        &mut self,
        token: AccountId,
        recipient: AccountId,
        amount: U128,
        relayer: Option<AccountId>,
        fee: U128,
        refund_inner: Option<FieldStr>,
    ) {
        let paid = matches!(env::promise_result_checked(0, 64), Ok(_));
        if paid {
            events::payout(events::Payout {
                token: &token,
                to: &recipient,
                amount,
                outcome: "paid",
                refund_commitment: None,
                leaf_index: None,
                root: None,
            });
        } else {
            self.refund(&token, &recipient, amount.0, refund_inner);
        }
        if fee.0 > 0 {
            let fee_paid = env::promise_results_count() > 1 && matches!(env::promise_result_checked(1, 64), Ok(_));
            if !fee_paid {
                // The relayer can claim it later; it never goes back into a note.
                let relayer = relayer.unwrap();
                self.hold(&token, &relayer, fee.0);
            }
        }
    }

    /// Claim tokens the pool could not pay out (only when no refund note was given).
    pub fn claim(&mut self, token: AccountId) -> Promise {
        let account = env::predecessor_account_id();
        let key = (account.clone(), token.clone());
        let amount = self.unclaimed.remove(&key).unwrap_or(0);
        require!(amount > 0, "Nothing to claim");
        ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(account.clone(), U128(amount), Some("Hushd claim".into()))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_ON_PAYOUT).on_claim(token, account, U128(amount)))
    }

    #[private]
    pub fn on_claim(&mut self, token: AccountId, account: AccountId, amount: U128) {
        if env::promise_result_checked(0, 64).is_err() {
            self.hold(&token, &account, amount.0);
        }
    }

    // ---------- rules ----------

    pub fn propose_change(&mut self, change: Change) -> U64 {
        self.assert_owner();
        let id = self.next_change;
        self.next_change += 1;
        let pending = Pending { change, apply_after_ns: U64(env::block_timestamp() + self.timelock_ns) };
        events::rule_change(events::RuleChange { id: U64(id), status: "proposed", apply_after_ns: pending.apply_after_ns, change: &pending.change });
        self.pending.insert(id, pending);
        U64(id)
    }

    pub fn cancel_change(&mut self, id: U64) {
        self.assert_owner();
        let p = self.pending.remove(&id.0).unwrap_or_else(|| env::panic_str("No such change"));
        events::rule_change(events::RuleChange { id, status: "cancelled", apply_after_ns: p.apply_after_ns, change: &p.change });
    }

    /// Anyone may apply a change once its timelock has passed.
    pub fn apply_change(&mut self, id: U64) {
        let p = self.pending.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("No such change"));
        require!(env::block_timestamp() >= p.apply_after_ns.0, "The timelock has not passed");
        self.pending.remove(&id.0);
        match p.change.clone() {
            Change::AddAsset { token, limits } => self.add_asset(token, limits),
            Change::SetLimits { token, limits } => {
                self.assets.get_mut(&token).unwrap_or_else(|| env::panic_str("Unknown token")).limits = limits
            }
            Change::SetDesk { desk } => self.desk = Some(desk),
            Change::SetOwner { owner } => self.owner = owner,
        }
        events::rule_change(events::RuleChange { id, status: "applied", apply_after_ns: p.apply_after_ns, change: &p.change });
    }

    /// Stop or restart new deposits. Cash outs and sends always work.
    pub fn set_deposits_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.deposits_paused = paused;
        events::deposits_paused(paused);
    }

    // ---------- views ----------

    pub fn get_root(&self) -> FieldStr {
        FieldStr(self.tree.root())
    }

    pub fn recent_roots(&self) -> Vec<FieldStr> {
        self.tree.recent_roots().into_iter().map(FieldStr).collect()
    }

    pub fn is_known_root(&self, root: FieldStr) -> bool {
        self.tree.is_known_root(&root.0)
    }

    pub fn next_leaf_index(&self) -> U64 {
        U64(self.tree.next_index)
    }

    /// Leaves from `from_index`, at most `limit` (up to 1000), in tree order.
    pub fn leaves(&self, from_index: U64, limit: u32) -> Vec<FieldStr> {
        let end = (from_index.0 + limit.min(1000) as u64).min(self.leaves.len() as u64);
        (from_index.0..end).filter_map(|i| self.leaves.get(i as u32).copied().map(FieldStr)).collect()
    }

    pub fn is_spent(&self, nullifier: FieldStr) -> bool {
        self.spends.contains_key(&nullifier.0)
    }

    pub fn spend_of(&self, nullifier: FieldStr) -> Option<SpendView> {
        self.spends.get(&nullifier.0).map(|s| SpendView {
            outputs: s.outputs.map(FieldStr),
            deal_id: s.deal.map(U64),
            block_height: U64(s.block),
        })
    }

    pub fn assets(&self) -> Vec<AssetView> {
        self.assets
            .iter()
            .map(|(token, a)| AssetView { token: token.clone(), field: FieldStr(a.field), limits: a.limits.clone(), held: U128(a.held) })
            .collect()
    }

    pub fn asset_field(&self, token: AccountId) -> FieldStr {
        FieldStr(field::asset_field(token.as_str()))
    }

    pub fn unclaimed(&self, account: AccountId, token: AccountId) -> U128 {
        U128(self.unclaimed.get(&(account, token)).copied().unwrap_or(0))
    }

    pub fn stats(&self) -> Stats {
        self.stats.clone()
    }

    pub fn config(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({
            "owner": self.owner,
            "desk": self.desk,
            "timelock_ns": U64(self.timelock_ns),
            "deposits_paused": self.deposits_paused,
            "levels": tree::LEVELS,
            "root_history": tree::ROOT_HISTORY,
            "pending": self.pending.iter().map(|(id, p)| near_sdk::serde_json::json!({"id": U64(*id), "pending": p})).collect::<Vec<_>>(),
        })
    }

    /// Check a proof made for one named reader. Public inputs follow each circuit's
    /// order (see circuits/). `legs` is the plain (commitment, nullifier) list of a
    /// volume proof. Context and expiry are checked by the reader against the label.
    pub fn verify_disclosure(
        &self,
        kind: String,
        proof: Proof,
        public_inputs: Vec<FieldStr>,
        legs: Option<Vec<[FieldStr; 2]>>,
    ) -> DisclosureCheck {
        let inputs: Vec<Field> = public_inputs.iter().map(|f| f.0).collect();
        let mut problems = Vec::new();
        let mut deal_ids = Vec::new();
        let (key, asset_at) = match kind.as_str() {
            "receipt" => (vk::receipt(), 2),
            "funds" => (vk::funds(), 1),
            "volume" => (vk::volume(), 0),
            _ => env::panic_str("kind is receipt, funds or volume"),
        };
        let proof_valid = groth16::verify(&key, &proof, &inputs);
        let token = inputs.get(asset_at).and_then(|f| self.token_by_field.get(f).cloned());
        if token.is_none() {
            problems.push("The proof names an asset the pool does not list".into());
        }
        if proof_valid {
            match kind.as_str() {
                "receipt" => {
                    let (commitment, nullifier) = (inputs[0], inputs[1]);
                    match self.spends.get(&nullifier) {
                        Some(s) if s.outputs.contains(&commitment) => deal_ids.push(s.deal.map(U64)),
                        Some(_) => problems.push("The paying note was spent, but not into this note".into()),
                        None => problems.push("The paying note was never spent in the pool".into()),
                    }
                }
                "funds" => {
                    if !self.tree.is_known_root(&inputs[0]) {
                        problems.push("The proof is against a root the pool no longer keeps".into());
                    }
                    let ns: Vec<Field> = inputs[4..].iter().copied().filter(|n| n != &ZERO).collect();
                    for (i, n) in ns.iter().enumerate() {
                        if ns[..i].contains(n) {
                            problems.push("A note is counted twice".into());
                        }
                        if self.spends.contains_key(n) {
                            problems.push("A note backing the proof has been spent since".into());
                        }
                    }
                }
                "volume" => {
                    let legs = legs.unwrap_or_default();
                    let mut h = Hasher::new();
                    let mut acc = ZERO;
                    let count = u64::from_be_bytes(inputs[2][24..].try_into().unwrap());
                    if legs.len() as u64 != count || legs.len() > 16 {
                        problems.push("The list of legs does not match the count".into());
                    }
                    for i in 0..16 {
                        let (c, n) = legs.get(i).map(|l| (l[0].0, l[1].0)).unwrap_or((ZERO, ZERO));
                        acc = h.hash3(&acc, &c, &n);
                    }
                    if acc != inputs[3] {
                        problems.push("The list of legs is not the one that was proven".into());
                    }
                    for (i, l) in legs.iter().enumerate() {
                        if legs[..i].iter().any(|m| m[0].0 == l[0].0 || m[1].0 == l[1].0) {
                            problems.push("A leg is counted twice".into());
                        }
                        match self.spends.get(&l[1].0) {
                            Some(s) if s.outputs.contains(&l[0].0) && s.deal.is_some() => deal_ids.push(s.deal.map(U64)),
                            Some(s) if s.outputs.contains(&l[0].0) => problems.push("A leg is a payment, not a desk settlement".into()),
                            _ => problems.push("A leg was never settled in the pool".into()),
                        }
                    }
                }
                _ => {}
            }
        }
        DisclosureCheck { proof_valid, chain_valid: proof_valid && problems.is_empty(), problems, token, deal_ids }
    }

    // ---------- internals ----------

    fn insert(&mut self, leaf: Field, h: &mut Hasher) -> u64 {
        let i = self.tree.insert(leaf, h);
        self.leaves.push(leaf);
        i
    }

    fn insert_pair(&mut self, a: Field, b: Field, h: &mut Hasher) -> u64 {
        let i = self.tree.insert_pair(a, b, h);
        self.leaves.push(a);
        self.leaves.push(b);
        i
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
    }

    fn add_asset(&mut self, token: AccountId, limits: Limits) {
        require!(!self.assets.contains_key(&token), "Token already listed");
        let f = field::asset_field(token.as_str());
        self.token_by_field.insert(f, token.clone());
        self.assets.insert(token, Asset { field: f, limits, held: 0 });
    }

    fn check_spendable(&self, root: &Field, nullifiers: &[Field]) {
        require!(self.tree.is_known_root(root), "Unknown root");
        require!(nullifiers.len() < 2 || nullifiers[0] != nullifiers[1], "A note appears twice");
        for n in nullifiers {
            require!(!self.spends.contains_key(n), "A note is already spent");
        }
    }

    /// Charge the caller for the storage this call added and return the rest.
    fn settle_storage(&mut self, before: u64) {
        self.spends.flush();
        self.leaves.flush();
        let added = env::storage_usage().saturating_sub(before) as u128;
        let cost = env::storage_byte_cost().saturating_mul(added);
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("Attach at least {} yoctoNEAR for storage", cost.as_yoctonear()));
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            let _ = Promise::new(env::predecessor_account_id()).transfer(refund);
        }
    }

    fn refund(&mut self, token: &AccountId, recipient: &AccountId, amount: u128, refund_inner: Option<FieldStr>) {
        self.stats.refunds += 1;
        match (refund_inner, self.assets.get(token).map(|a| a.field)) {
            (Some(inner), Some(asset)) => {
                let mut h = Hasher::new();
                let commitment = h.hash3(&inner.0, &field::from_u128(amount), &asset);
                let leaf_index = self.insert(commitment, &mut h);
                self.assets.get_mut(token).unwrap().held += amount;
                events::payout(events::Payout {
                    token,
                    to: recipient,
                    amount: U128(amount),
                    outcome: "refunded",
                    refund_commitment: Some(FieldStr(commitment)),
                    leaf_index: Some(U64(leaf_index)),
                    root: Some(FieldStr(self.tree.root())),
                });
            }
            _ => self.hold(token, recipient, amount),
        }
    }

    fn hold(&mut self, token: &AccountId, account: &AccountId, amount: u128) {
        let key = (account.clone(), token.clone());
        let now = self.unclaimed.get(&key).copied().unwrap_or(0);
        self.unclaimed.insert(key, now + amount);
        events::payout(events::Payout {
            token,
            to: account,
            amount: U128(amount),
            outcome: "held",
            refund_commitment: None,
            leaf_index: None,
            root: None,
        });
    }

    fn try_shield(&mut self, token: &AccountId, amount: u128, msg: &str) -> Result<(u64, Field), &'static str> {
        if self.deposits_paused {
            return Err("Deposits are paused");
        }
        let asset = self.assets.get(token).ok_or("This token is not listed")?;
        if amount == 0 {
            return Err("Nothing to deposit");
        }
        if amount > asset.limits.per_deposit.0 {
            return Err("Above the per-deposit limit");
        }
        if asset.held.checked_add(amount).ok_or("Overflow")? > asset.limits.total.0 {
            return Err("Above the pool's total limit for this token");
        }
        let parsed: ShieldMsg = near_sdk::serde_json::from_str(msg).map_err(|_| "msg must be {\"inner\": \"<field>\"}")?;
        if parsed.inner.0 == ZERO {
            return Err("inner must not be zero");
        }
        let asset_field = asset.field;
        let mut h = Hasher::new();
        let commitment = h.hash3(&parsed.inner.0, &field::from_u128(amount), &asset_field);
        let leaf_index = self.insert(commitment, &mut h);
        self.assets.get_mut(token).unwrap().held += amount;
        self.stats.shields += 1;
        Ok((leaf_index, commitment))
    }
}

#[near]
impl FungibleTokenReceiver for Pool {
    /// Shield: msg is `{"inner": "<field>"}`. A deposit the pool cannot take is
    /// returned in full by the token contract.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        match self.try_shield(&token, amount.0, &msg) {
            Ok((leaf_index, commitment)) => {
                events::shield(events::Shield {
                    token: &token,
                    amount,
                    commitment: FieldStr(commitment),
                    leaf_index: U64(leaf_index),
                    root: FieldStr(self.tree.root()),
                });
                PromiseOrValue::Value(U128(0))
            }
            Err(reason) => {
                events::shield_refused(events::ShieldRefused { token: &token, sender: &sender_id, amount, reason });
                PromiseOrValue::Value(amount)
            }
        }
    }
}

#[cfg(test)]
mod tests;
