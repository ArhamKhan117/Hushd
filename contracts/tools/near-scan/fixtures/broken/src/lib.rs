//! A contract with one of each classic mistake, parsed (never built) by near-scan's test.
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, Gas, Promise, PromiseOrValue};

#[near(contract_state)]
pub struct Broken {
    owner: AccountId,
    seen: LookupSet<u64>,
    a: LookupMap<u32, u32>,
}

#[near]
impl Broken {
    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        self.owner = owner;
    }

    pub fn price(&self) -> u64 {
        1
    }

    pub fn lottery(&mut self) -> u8 {
        env::random_seed()[0]
    }

    pub fn rate(&self) -> f64 {
        0.5
    }

    pub fn pay(&mut self, to: AccountId) {
        ext_ft::ext(to.clone()).ft_transfer(to, U128(1), None);
    }

    pub fn withdraw(&mut self, to: AccountId) -> Promise {
        ext_ft::ext(to.clone())
            .with_static_gas(Gas::from_tgas(10))
            .ft_transfer(to, U128(1), None)
            .then(ext_self::ext(env::current_account_id()).on_withdrawn())
    }

    pub fn on_withdrawn(&mut self) {
        if env::promise_result_checked(0, 0).is_err() {
            self.a.insert(1, 1);
        }
    }

    pub fn mark(&mut self, n: U128) {
        self.seen.insert(n.0 as u64);
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        PromiseOrValue::Value(U128(0))
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
    }

    pub fn add(&mut self, k: u32) {
        let before = env::storage_usage();
        self.a.insert(k, k);
        self.charge(before);
    }

    fn charge(&mut self, before: u64) {
        let added = env::storage_usage() - before;
        require!(env::attached_deposit() >= env::storage_byte_cost().saturating_mul(added as u128), "Attach more");
    }

    fn maps() {
        let _ = LookupMap::<u32, u32>::new(b"m");
        let _ = LookupMap::<u32, u32>::new(b"m");
    }
}
