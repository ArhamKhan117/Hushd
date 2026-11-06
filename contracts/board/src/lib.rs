//! Hushd board: where a payer leaves word of a payment for its recipient.
//!
//! Paying a note to someone does not tell them about it. The payer encrypts the
//! note's opening to the recipient's X25519 key and posts the ciphertext here;
//! every recipient pages through all posts and trial-decrypts each one.
//!
//! The board never records who posted: no poster in storage, none in events.
//! Posts normally come from the Hushd relayer, but anyone may post. Each post is
//! paid for from the poster's NEP-145 storage balance, measured byte for byte.
//! Posts are permanent: nobody can delete them, and the owner can only change
//! the size limit.

mod events;
#[cfg(test)]
mod tests;

use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

pub const DEFAULT_MAX_POST_BYTES: u32 = 2048;
pub const MAX_TAG_BYTES: usize = 32;
pub const MAX_PAGE: u32 = 100;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Posts,
    Balances,
}

#[near(serializers = [borsh])]
pub struct Post {
    pub data: Vec<u8>,
    pub tag: Option<String>,
    pub block_height: u64,
    pub timestamp_ns: u64,
}

#[near(serializers = [json])]
pub struct PostView {
    pub index: U64,
    pub data: Base64VecU8,
    pub tag: Option<String>,
    pub block_height: U64,
    pub timestamp_ns: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Board {
    owner: AccountId,
    max_post_bytes: u32,
    posts: Vector<Post>,
    /// Storage balance per account, registration minimum included.
    balances: LookupMap<AccountId, NearToken>,
    /// Bytes one balance entry takes, measured at init with the longest account id.
    balance_entry_bytes: u64,
}

#[near]
impl Board {
    /// `max_post_bytes` defaults to 2048, room for an encrypted note opening with plenty to spare.
    #[init]
    pub fn new(owner_id: AccountId, max_post_bytes: Option<u32>) -> Self {
        let max_post_bytes = max_post_bytes.unwrap_or(DEFAULT_MAX_POST_BYTES);
        require!(max_post_bytes > 0, "The size limit must be at least 1 byte");
        let mut board = Self {
            owner: owner_id,
            max_post_bytes,
            posts: Vector::new(Key::Posts),
            balances: LookupMap::new(Key::Balances),
            balance_entry_bytes: 0,
        };
        board.balance_entry_bytes = board.measure_balance_entry();
        board
    }

    /// Post a ciphertext for its recipient to find. `tag` is a short public hint
    /// ("note", "deal") so readers can skip what they do not care about.
    /// The storage this adds is charged to the caller's storage balance.
    pub fn post(&mut self, ciphertext: Base64VecU8, tag: Option<String>) -> U64 {
        let data = ciphertext.0;
        require!(!data.is_empty(), "A post cannot be empty");
        require!(
            data.len() <= self.max_post_bytes as usize,
            format!("A post is at most {} bytes", self.max_post_bytes)
        );
        if let Some(t) = &tag {
            require!(t.len() <= MAX_TAG_BYTES, format!("A tag is at most {MAX_TAG_BYTES} bytes"));
        }

        let bytes = data.len() as u32;
        let index = self.posts.len();
        let before = env::storage_usage();
        self.posts.push(Post {
            data,
            tag: tag.clone(),
            block_height: env::block_height(),
            timestamp_ns: env::block_timestamp(),
        });
        self.posts.flush();
        let added = env::storage_usage().saturating_sub(before);
        self.charge(&env::predecessor_account_id(), env::storage_byte_cost().saturating_mul(added as u128));

        events::post(events::Post { index: U64(index as u64), bytes, tag: tag.as_deref() });
        U64(index as u64)
    }

    /// Owner only, attach 1 yoctoNEAR: the one setting the owner controls.
    #[payable]
    pub fn set_max_post_bytes(&mut self, max_post_bytes: u32) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "Owner only");
        require!(max_post_bytes > 0, "The size limit must be at least 1 byte");
        self.max_post_bytes = max_post_bytes;
        events::max_post_bytes(max_post_bytes);
    }

    // ---------- views ----------

    pub fn count(&self) -> U64 {
        U64(self.posts.len() as u64)
    }

    /// Up to `limit` posts from `from_index` on, oldest first; at most 100 per page.
    pub fn posts(&self, from_index: U64, limit: u32) -> Vec<PostView> {
        let len = self.posts.len();
        let from = from_index.0.min(len as u64) as u32;
        let to = from.saturating_add(limit.min(MAX_PAGE)).min(len);
        (from..to).filter_map(|i| self.view(i)).collect()
    }

    /// One post. Named `get_post` because `post` is the call that adds one.
    pub fn get_post(&self, index: U64) -> Option<PostView> {
        u32::try_from(index.0).ok().and_then(|i| self.view(i))
    }

    pub fn max_post_bytes(&self) -> u32 {
        self.max_post_bytes
    }

    // ---------- internals ----------

    fn view(&self, index: u32) -> Option<PostView> {
        self.posts.get(index).map(|p| PostView {
            index: U64(index as u64),
            data: Base64VecU8(p.data.clone()),
            tag: p.tag.clone(),
            block_height: U64(p.block_height),
            timestamp_ns: U64(p.timestamp_ns),
        })
    }

    fn measure_balance_entry(&mut self) -> u64 {
        let before = env::storage_usage();
        let longest: AccountId = "a".repeat(64).parse().unwrap();
        self.balances.insert(longest.clone(), NearToken::from_yoctonear(u128::MAX));
        self.balances.flush();
        let bytes = env::storage_usage() - before;
        self.balances.remove(&longest);
        self.balances.flush();
        bytes
    }

    fn min_balance(&self) -> NearToken {
        env::storage_byte_cost().saturating_mul(self.balance_entry_bytes as u128)
    }

    fn storage_balance(&self, total: NearToken) -> StorageBalance {
        StorageBalance { total, available: total.saturating_sub(self.min_balance()) }
    }

    fn charge(&mut self, account_id: &AccountId, cost: NearToken) {
        let min = self.min_balance();
        let balance = self
            .balances
            .get_mut(account_id)
            .unwrap_or_else(|| env::panic_str("Register with storage_deposit before posting"));
        let available = balance.saturating_sub(min);
        require!(
            available >= cost,
            format!(
                "Storage balance too low: this post needs {} yoctoNEAR and {} is available; top up with storage_deposit",
                cost.as_yoctonear(),
                available.as_yoctonear()
            )
        );
        *balance = balance.saturating_sub(cost);
    }
}

fn pay(to: AccountId, amount: NearToken) {
    if !amount.is_zero() {
        Promise::new(to).transfer(amount).detach();
    }
}

/// NEP-145. The balance is spent by posting and never comes back for posts,
/// since posts are permanent and not tied to an account. The minimum covers only
/// the account's own balance entry.
#[near]
impl StorageManagement for Board {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let amount = env::attached_deposit();
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        let registration_only = registration_only.unwrap_or(false);
        let min = self.min_balance();
        let total = match self.balances.get(&account_id).copied() {
            Some(total) if registration_only => {
                pay(env::predecessor_account_id(), amount);
                total
            }
            Some(total) => total.saturating_add(amount),
            None => {
                require!(
                    amount >= min,
                    format!("Attach at least {} yoctoNEAR to register", min.as_yoctonear())
                );
                if registration_only {
                    pay(env::predecessor_account_id(), amount.saturating_sub(min));
                    min
                } else {
                    amount
                }
            }
        };
        self.balances.insert(account_id, total);
        self.storage_balance(total)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let min = self.min_balance();
        let total = self
            .balances
            .get_mut(&account_id)
            .unwrap_or_else(|| env::panic_str("The account is not registered"));
        let available = total.saturating_sub(min);
        let amount = amount.unwrap_or(available);
        require!(amount <= available, "Cannot withdraw more than the available balance");
        *total = total.saturating_sub(amount);
        let left = *total;
        pay(account_id, amount);
        self.storage_balance(left)
    }

    /// Returns the whole balance. `force` changes nothing: the account owns no
    /// data here beyond its balance, so there is never anything to forfeit.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let _ = force;
        let account_id = env::predecessor_account_id();
        match self.balances.remove(&account_id) {
            Some(total) => {
                pay(account_id, total);
                true
            }
            None => false,
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: self.min_balance(), max: None }
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.balances.get(&account_id).map(|&total| self.storage_balance(total))
    }
}
