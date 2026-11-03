//! Hushd testnet tokens (testnet only): a standard NEP-141 token with NEP-145
//! storage and NEP-148 metadata, plus a faucet. The faucet gives a fixed amount
//! per account per cooldown and registers the receiver's storage itself, so a new
//! account can get tokens in one call. The owner can mint to seed the reference makers.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::LazyOption;
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Key {
    Token,
    Metadata,
    LastDrip,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Token {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    owner: AccountId,
    faucet_amount: u128,
    faucet_cooldown_ns: u64,
    last_drip: LookupMap<AccountId, u64>,
}

#[near(serializers = [json])]
pub struct FaucetInfo {
    pub amount: U128,
    pub cooldown_ns: U64,
    pub next_at_ns: U64,
}

#[near]
impl Token {
    #[init]
    pub fn new(owner_id: AccountId, name: String, symbol: String, decimals: u8, icon: Option<String>, faucet_amount: U128, faucet_cooldown_ns: U64) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon,
            reference: None,
            reference_hash: None,
            decimals,
        };
        metadata.assert_valid();
        Self {
            token: FungibleToken::new(Key::Token),
            metadata: LazyOption::new(Key::Metadata, Some(&metadata)),
            owner: owner_id,
            faucet_amount: faucet_amount.0,
            faucet_cooldown_ns: faucet_cooldown_ns.0,
            last_drip: LookupMap::new(Key::LastDrip),
        }
    }

    /// Faucet for the caller.
    pub fn faucet(&mut self) -> U128 {
        self.drip(env::predecessor_account_id())
    }

    /// Faucet for any account (a relayer can fund a new passkey account). Same cooldown.
    pub fn faucet_for(&mut self, account_id: AccountId) -> U128 {
        self.drip(account_id)
    }

    pub fn faucet_info(&self, account_id: AccountId) -> FaucetInfo {
        let next = self.last_drip.get(&account_id).map(|t| t + self.faucet_cooldown_ns).unwrap_or(0);
        FaucetInfo { amount: U128(self.faucet_amount), cooldown_ns: U64(self.faucet_cooldown_ns), next_at_ns: U64(next) }
    }

    /// Owner only: seed an account (the reference makers' inventory).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
        self.register_if_needed(&account_id);
        self.token.internal_deposit(&account_id, amount.0);
        FtMint { owner_id: &account_id, amount, memo: Some("mint") }.emit();
    }

    fn drip(&mut self, account_id: AccountId) -> U128 {
        let now = env::block_timestamp();
        if let Some(last) = self.last_drip.get(&account_id) {
            require!(now >= last + self.faucet_cooldown_ns, "The faucet has already paid this account; try again later");
        }
        self.last_drip.insert(account_id.clone(), now);
        self.register_if_needed(&account_id);
        self.token.internal_deposit(&account_id, self.faucet_amount);
        FtMint { owner_id: &account_id, amount: U128(self.faucet_amount), memo: Some("faucet") }.emit();
        U128(self.faucet_amount)
    }

    fn register_if_needed(&mut self, account_id: &AccountId) {
        if !self.token.accounts.contains_key(account_id) {
            self.token.internal_register_account(account_id);
        }
    }
}

#[near]
impl FungibleTokenCore for Token {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Token {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            FtBurn { owner_id: &sender_id, amount: U128(burned), memo: Some("receiver closed") }.emit();
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Token {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Token {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(who: &str, ts: u64) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(who.parse().unwrap()).block_timestamp(ts);
        testing_env!(b.build());
    }

    fn token() -> Token {
        ctx("owner.test", 0);
        Token::new("owner.test".parse().unwrap(), "USD Coin (Hushd testnet)".into(), "USDC".into(), 6, None, U128(1_000_000_000), U64(3_600_000_000_000))
    }

    #[test]
    fn faucet_pays_once_per_cooldown_and_registers() {
        let mut t = token();
        ctx("alice.test", 1);
        assert_eq!(t.faucet().0, 1_000_000_000);
        assert_eq!(t.ft_balance_of("alice.test".parse().unwrap()).0, 1_000_000_000);
        ctx("alice.test", 3_600_000_000_001);
        t.faucet();
        assert_eq!(t.ft_total_supply().0, 2_000_000_000);
    }

    #[test]
    #[should_panic(expected = "already paid")]
    fn faucet_refuses_inside_the_cooldown() {
        let mut t = token();
        ctx("alice.test", 1);
        t.faucet();
        ctx("bob.test", 2);
        t.faucet_for("alice.test".parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "Owner only")]
    fn only_the_owner_mints() {
        let mut t = token();
        ctx("alice.test", 1);
        t.mint("alice.test".parse().unwrap(), U128(5));
    }
}
