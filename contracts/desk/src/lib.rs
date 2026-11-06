//! Hushd desk: the OTC registry.
//!
//! - Makers register, post a bond in the bond token (`ft_transfer_call` with msg
//!   `"bond"`) and are public, like any market maker. Traders never appear.
//! - An RFQ is opened as a commitment (a hash of the encrypted request).
//! - A deal exists only when the enclave matcher says so: either its result comes
//!   back through `outlayer` (the OutLayer contract resumes our call with the output
//!   of a TEE worker running the pinned matcher) or it carries a signature by the
//!   enclave's ed25519 key, which the desk itself fetched through OutLayer.
//! - Settlement classes: `atomic_pool` (both legs in one pool call), `bonded_hedge`
//!   (an atomic pool swap plus a Hyperliquid leg the maker's bond guarantees) and
//!   `atomic_intents` (settled on NEAR Intents, recorded with its evidence).
//! - Every deal ends with a receipt and the evidence behind it: settled, recovered, failed or
//!   unresolved. A failed hedge leg slashes the maker's bond into the pool as a
//!   private note for the trader.
//! - The pool, the bond token and the MPC are fixed at init. Every other setting
//!   changes only through `propose_config`, a timelock and `apply_config`.

mod events;
pub mod hedge;

use hedge::HedgeSpec;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue, PublicKey,
};

const GAS_POOL_SETTLE: Gas = Gas::from_tgas(180);
const GAS_ON_SETTLED: Gas = Gas::from_tgas(15);
const GAS_FT: Gas = Gas::from_tgas(15);
const GAS_FT_CALL: Gas = Gas::from_tgas(80);
const GAS_CALLBACK: Gas = Gas::from_tgas(20);
const GAS_MPC: Gas = Gas::from_tgas(60);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Storage a deal record may take, held from the call that creates it.
const DEAL_STORAGE: NearToken = NearToken::from_millinear(10);
/// A hedge leg's opening order may be signed this many times before its deadline.
pub const MAX_HEDGE_ATTEMPTS: u32 = 3;
/// A match must reach the desk within this long after its RFQ closed.
pub const MATCH_GRACE_MS: u64 = 15 * 60_000;
/// r, big-endian: the BN254 scalar field modulus. The pool only takes notes below it.
const FIELD_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];
const BOND_BUG: &str = "Bond accounting error";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Makers,
    Rfqs,
    Deals,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SettlementClass {
    AtomicPool,
    BondedHedge,
    AtomicIntents,
}

impl SettlementClass {
    /// The class byte in the bytes makers sign (the same tags as the protocol package).
    pub fn tag(self) -> u8 {
        match self {
            SettlementClass::AtomicPool => 0,
            SettlementClass::BondedHedge => 1,
            SettlementClass::AtomicIntents => 2,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DealStatus {
    /// Matched in the enclave, waiting for both legs.
    Matched,
    /// `settle` is waiting for the pool; nothing else can touch the deal until it answers.
    Settling,
    /// Spot settled; the Hyperliquid leg is still open.
    HedgePending,
    /// The slashed bond is on its way into the pool as the trader's note.
    Slashing,
    /// The pool refused the slashed bond (paused, a limit): the desk holds it in
    /// `slash_held` and anyone may `retry_slash_payout`.
    SlashRefused,
    /// Finished with a receipt.
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Settled,
    Recovered,
    Failed,
    Unresolved,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Evidence {
    pub kind: String,
    pub reference: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Receipt {
    pub outcome: Outcome,
    pub evidence: Vec<Evidence>,
    pub recorded_at_ms: U64,
}

/// What the enclave returns for an RFQ. The desk checks it against chain state and
/// stores it; `signing_bytes` is what the enclave signs.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MatchResult {
    pub rfq_id: U64,
    pub maker: AccountId,
    /// Hash of the agreed terms (0x hex); the terms themselves stay with the two parties.
    pub terms_hash: String,
    pub class: SettlementClass,
    pub expires_at_ms: U64,
    /// Bond the maker locks for this deal (0 for atomic deals).
    pub bond: U128,
    /// `inner` (0x hex field) of the trader's note for a slash payout.
    pub trader_inner: Option<String>,
    /// The trader's per-deal ed25519 key ("ed25519:<base58>"), for actions only the trader may take.
    pub owner_key: Option<String>,
    pub hedge: Option<HedgeSpec>,
    /// The maker's quote key's signature over `consent_bytes`: the maker agreed to exactly these terms.
    pub maker_sig: Base64VecU8,
}

fn push_str(b: &mut Vec<u8>, s: &str) {
    b.extend_from_slice(&(s.len() as u32).to_le_bytes());
    b.extend_from_slice(s.as_bytes());
}

impl MatchResult {
    /// What the enclave signs: "hushd.match.v2" ‖ desk account (u32 LE length ‖ utf8) ‖ the
    /// match's borsh bytes. The same bytes as `signing_bytes` in matcher/src/terms.rs.
    pub fn signing_bytes(&self, desk: &AccountId) -> Vec<u8> {
        let mut b = b"hushd.match.v2".to_vec();
        push_str(&mut b, desk.as_str());
        b.extend_from_slice(&near_sdk::borsh::to_vec(self).expect("borsh"));
        b
    }

    /// What the maker's quote key signs (consent v2): "hushd.quote.v2" ‖ desk account
    /// (u32 LE length ‖ utf8) ‖ rfq id (u64 LE) ‖ terms hash (32) ‖ bond (u128 LE) ‖ expiry
    /// (u64 LE) ‖ class (u8) ‖ hedge hash (32: sha256 of the hedge spec's borsh bytes, or
    /// zeros) ‖ maker account (u32 LE length ‖ utf8). Built here from the match itself, so a
    /// matcher cannot attach a class, a hedge or a maker the maker did not sign. The same
    /// bytes as `consentBytes` in the protocol package and `Consent::bytes` in matcher/src/terms.rs.
    /// None when the terms hash is unreadable.
    pub fn consent_bytes(&self, desk: &AccountId) -> Option<Vec<u8>> {
        let terms_hash = parse_hex32(&self.terms_hash)?;
        let mut b = b"hushd.quote.v2".to_vec();
        push_str(&mut b, desk.as_str());
        b.extend_from_slice(&self.rfq_id.0.to_le_bytes());
        b.extend_from_slice(&terms_hash);
        b.extend_from_slice(&self.bond.0.to_le_bytes());
        b.extend_from_slice(&self.expires_at_ms.0.to_le_bytes());
        b.push(self.class.tag());
        b.extend_from_slice(&hedge::spec_hash(self.hedge.as_ref()));
        push_str(&mut b, self.maker.as_str());
        Some(b)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Deal {
    pub id: U64,
    pub rfq_id: U64,
    pub maker: AccountId,
    pub terms_hash: String,
    pub class: SettlementClass,
    pub matched_at_ms: U64,
    pub expires_at_ms: U64,
    pub bond: U128,
    pub trader_inner: Option<String>,
    pub owner_key: Option<String>,
    pub hedge: Option<HedgeSpec>,
    pub status: DealStatus,
    pub settle_attempts: u32,
    /// Hedge orders signed and not yet reported missed: 1 while the opening order is out
    /// (or filled), 2 once the trader closed it.
    pub hedge_orders: u32,
    /// Opening orders signed so far, at most `MAX_HEDGE_ATTEMPTS`.
    pub hedge_attempts: u32,
    /// The deal's bond has left the maker's locked bond (released or slashed): at most once.
    pub bond_released: bool,
    /// Slashed bond the desk still holds for the trader (in flight or refused by the pool).
    pub slash_held: U128,
    /// How the match reached the desk: "outlayer" or "enclave_signature".
    pub attested_by: String,
    pub receipt: Option<Receipt>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Maker {
    pub name: String,
    /// X25519 key (hex) makers' quotes are answered to.
    pub enc_key: String,
    /// Where the maker answers RFQs (charges per quote over x402).
    pub quote_url: String,
    /// Pricing style, shown in the app: "fixed", "volatility", "inventory", ...
    pub style: String,
    /// The ed25519 key ("ed25519:<base58>") that signs this maker's quotes.
    pub quote_key: String,
    pub bond: U128,
    pub locked: U128,
    pub deals: u32,
    pub slashed: U128,
    pub active: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Rfq {
    pub id: U64,
    /// sha256 of the encrypted request (0x hex).
    pub commitment: String,
    pub opened_at_ms: U64,
    pub closes_at_ms: U64,
    pub deal_id: Option<U64>,
}

/// The desk's settings. `pool`, `bond_token`, `mpc` and `config_timelock_ns` are fixed
/// at init; the rest change only through `propose_config` and `apply_config`.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Config {
    pub owner: AccountId,
    pub pool: AccountId,
    pub bond_token: AccountId,
    pub outlayer: AccountId,
    /// OutLayer project of the matcher, "owner/name".
    pub matcher_project: String,
    /// Account whose OutLayer secrets the matcher runs with.
    pub secrets_owner: AccountId,
    pub mpc: AccountId,
    /// Reports Hyperliquid fills and Intents evidence until the enclave reports them.
    pub keeper: AccountId,
    pub outlayer_fee: U128,
    pub min_bond: U128,
    /// How long a proposed config change waits before it can be applied.
    pub config_timelock_ns: U64,
}

/// The settings `propose_config` can change (all of them at once).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigChange {
    pub owner: AccountId,
    pub outlayer: AccountId,
    pub matcher_project: String,
    pub secrets_owner: AccountId,
    pub keeper: AccountId,
    pub outlayer_fee: U128,
    pub min_bond: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PendingConfig {
    pub id: U64,
    pub change: ConfigChange,
    pub apply_after_ns: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Stats {
    pub rfqs: u64,
    pub deals: u64,
    pub settled: u64,
    pub recovered: u64,
    pub failed: u64,
    pub unresolved: u64,
    pub slashed: U128,
}

#[ext_contract(ext_outlayer)]
#[allow(dead_code)]
trait OutLayer {
    fn request_execution(
        &mut self,
        code_source: Value,
        resource_limits: Value,
        input_data: String,
        secrets_ref: Option<Value>,
        response_format: String,
        payer_account_id: Option<AccountId>,
    );
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128>;
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callbacks {
    fn on_match(&mut self, rfq_id: U64);
    fn on_enclave_key(&mut self);
    fn on_settled(&mut self, deal_id: U64);
    fn on_hedge_signed(&mut self, deal_id: U64, nonce: U64, close: bool) -> Option<Value>;
    fn on_slash_paid(&mut self, deal_id: U64, amount: U128);
    fn on_bond_withdrawn(&mut self, maker: AccountId, amount: U128);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Desk {
    config: Config,
    /// The matcher enclave's ed25519 key, set only from an attested OutLayer call.
    enclave_key: Option<[u8; 32]>,
    /// The enclave's X25519 key (hex) that RFQs and quotes are encrypted to.
    enclave_enc_key: Option<String>,
    makers: IterableMap<AccountId, Maker>,
    rfqs: LookupMap<u64, Rfq>,
    deals: IterableMap<u64, Deal>,
    next_rfq: u64,
    next_deal: u64,
    stats: Stats,
    pending_config: Option<PendingConfig>,
    next_config_change: u64,
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

/// The 32 key bytes of "ed25519:<base58>".
fn ed25519_key(s: &str) -> Option<[u8; 32]> {
    let pk: PublicKey = s.parse().ok()?;
    let b = pk.as_bytes();
    // the first byte is the curve: 0 is ed25519
    if b.len() != 33 || b[0] != 0 {
        return None;
    }
    b[1..].try_into().ok()
}

fn parse_hex32(s: &str) -> Option<[u8; 32]> {
    let h = s.strip_prefix("0x")?;
    let mut out = [0u8; 32];
    hex::decode_to_slice(h, &mut out).ok()?;
    Some(out)
}

/// A note `inner` the pool will take: 0x and 64 hex digits, below r and not zero.
fn parse_field_hex(s: &str) -> Option<[u8; 32]> {
    parse_hex32(s).filter(|b| *b < FIELD_MODULUS && *b != [0u8; 32])
}

#[near]
impl Desk {
    #[init]
    pub fn new(config: Config) -> Self {
        Self {
            config,
            enclave_key: None,
            enclave_enc_key: None,
            makers: IterableMap::new(Key::Makers),
            rfqs: LookupMap::new(Key::Rfqs),
            deals: IterableMap::new(Key::Deals),
            next_rfq: 0,
            next_deal: 0,
            stats: Stats::default(),
            pending_config: None,
            next_config_change: 0,
        }
    }

    // ---------- the enclave ----------

    /// Ask the matcher enclave for its public keys through OutLayer. Whatever the
    /// attested worker returns becomes the desk's enclave key: no one types it in.
    #[payable]
    pub fn refresh_enclave_key(&mut self) -> Promise {
        let fee = env::attached_deposit();
        require!(fee >= NearToken::from_yoctonear(self.config.outlayer_fee.0), "Attach the OutLayer fee");
        self.outlayer_call(json!({ "cmd": "pubkey" }).to_string(), fee)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_enclave_key())
    }

    #[private]
    pub fn on_enclave_key(&mut self, #[callback_result] result: Result<Option<String>, PromiseError>) {
        let out = Self::outlayer_output(result).unwrap_or_else(|e| env::panic_str(&e));
        let sign = out["sign_key"].as_str().and_then(parse_hex32).unwrap_or_else(|| env::panic_str("No signing key"));
        let enc = out["enc_key"].as_str().filter(|k| k.len() == 66 && k.starts_with("0x")).unwrap_or_else(|| env::panic_str("No encryption key"));
        self.enclave_key = Some(sign);
        self.enclave_enc_key = Some(enc.to_string());
        events::emit("enclave_key", json!({ "sign_key": format!("0x{}", hex::encode(sign)), "enc_key": enc }));
    }

    // ---------- makers and bonds ----------

    /// Register or update the caller as a maker. Pays its own storage (attach 0.01 NEAR).
    #[payable]
    pub fn register_maker(&mut self, name: String, enc_key: String, quote_url: String, style: String, quote_key: String) {
        require!(name.len() <= 48 && quote_url.len() <= 200 && style.len() <= 24, "Field too long");
        require!(enc_key.len() == 66 && enc_key.starts_with("0x"), "enc_key is a 0x hex X25519 key");
        require!(ed25519_key(&quote_key).is_some(), "quote_key is an ed25519 public key");
        let maker = env::predecessor_account_id();
        let before = env::storage_usage();
        let entry = match self.makers.get(&maker) {
            Some(m) => Maker { name, enc_key, quote_url, style, quote_key, active: true, ..m.clone() },
            None => Maker {
                name,
                enc_key,
                quote_url,
                style,
                quote_key,
                bond: U128(0),
                locked: U128(0),
                deals: 0,
                slashed: U128(0),
                active: true,
            },
        };
        self.makers.insert(maker.clone(), entry);
        self.charge_storage(before);
        events::emit("maker_registered", json!({ "maker": maker }));
    }

    /// Attach 1 yoctoNEAR.
    #[payable]
    pub fn set_maker_active(&mut self, active: bool) {
        assert_one_yocto();
        let maker = env::predecessor_account_id();
        let m = self.makers.get_mut(&maker).unwrap_or_else(|| env::panic_str("Not a maker"));
        m.active = active;
    }

    /// Withdraw unlocked bond. Attach 1 yoctoNEAR.
    #[payable]
    pub fn withdraw_bond(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let maker = env::predecessor_account_id();
        let m = self.makers.get_mut(&maker).unwrap_or_else(|| env::panic_str("Not a maker"));
        require!(m.bond.0 - m.locked.0 >= amount.0 && amount.0 > 0, "Not that much unlocked bond");
        m.bond = U128(m.bond.0 - amount.0);
        events::emit("bond_withdrawn", json!({ "maker": maker, "amount": amount }));
        ext_ft::ext(self.config.bond_token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT)
            .ft_transfer(maker.clone(), amount, Some("Hushd bond".into()))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_bond_withdrawn(maker, amount))
    }

    #[private]
    pub fn on_bond_withdrawn(&mut self, maker: AccountId, amount: U128) {
        // only a failed transfer failed: a success with an unexpected value is still a success
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            if let Some(m) = self.makers.get_mut(&maker) {
                m.bond = U128(m.bond.0 + amount.0);
            }
            events::emit("bond_returned", json!({ "maker": maker, "amount": amount }));
        }
    }

    // ---------- RFQs and matches ----------

    /// Open an RFQ: only a commitment to the encrypted request goes on chain.
    /// Normally sent by the relayer, so the trader's account never appears.
    #[payable]
    pub fn open_rfq(&mut self, commitment: String, window_ms: U64) -> U64 {
        require!(parse_hex32(&commitment).is_some(), "commitment is 0x hex, 32 bytes");
        require!(window_ms.0 >= 1_000 && window_ms.0 <= 3_600_000, "Window between 1 s and 1 h");
        let before = env::storage_usage();
        let id = self.next_rfq;
        self.next_rfq += 1;
        let rfq = Rfq { id: U64(id), commitment, opened_at_ms: U64(now_ms()), closes_at_ms: U64(now_ms() + window_ms.0), deal_id: None };
        events::emit_t("rfq_opened", &rfq);
        self.rfqs.insert(id, rfq);
        self.stats.rfqs += 1;
        self.charge_storage(before);
        U64(id)
    }

    /// Send the sealed batch (the encrypted RFQ and every encrypted quote) to the
    /// matcher enclave through OutLayer. Its answer comes back to `on_match`.
    /// Attach the OutLayer fee plus 0.01 NEAR for the deal's storage.
    #[payable]
    pub fn request_match(&mut self, rfq_id: U64, sealed_batch: String) -> Promise {
        let rfq = self.rfqs.get(&rfq_id.0).unwrap_or_else(|| env::panic_str("No such RFQ"));
        require!(rfq.deal_id.is_none(), "This RFQ already has a deal");
        let fee = self.config.outlayer_fee.0;
        require!(env::attached_deposit().as_yoctonear() >= fee + DEAL_STORAGE.as_yoctonear(), "Attach the OutLayer fee and 0.01 NEAR");
        // the enclave signs the match for this desk (consent and match bytes both name it)
        let input = json!({ "cmd": "match", "desk": env::current_account_id(), "rfq_id": rfq_id, "rfq_commitment": rfq.commitment, "batch": sealed_batch }).to_string();
        self.outlayer_call(input, NearToken::from_yoctonear(fee))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(40)).on_match(rfq_id))
    }

    #[private]
    pub fn on_match(&mut self, rfq_id: U64, #[callback_result] result: Result<Option<String>, PromiseError>) -> Option<U64> {
        let out = match Self::outlayer_output(result) {
            Ok(v) => v,
            Err(e) => {
                events::emit("match_failed", json!({ "rfq_id": rfq_id, "reason": e }));
                return None;
            }
        };
        if out["matched"] == json!(false) {
            events::emit("no_match", json!({ "rfq_id": rfq_id, "reason": out["reason"] }));
            return None;
        }
        let m: MatchResult = match serde_json::from_value(out["match"].clone()) {
            Ok(m) => m,
            Err(_) => {
                events::emit("match_failed", json!({ "rfq_id": rfq_id, "reason": "unreadable match" }));
                return None;
            }
        };
        match self.accept_match(m, rfq_id, "outlayer") {
            Ok(id) => Some(id),
            Err(e) => {
                events::emit("match_failed", json!({ "rfq_id": rfq_id, "reason": e }));
                None
            }
        }
    }

    /// The same match, delivered by anyone with the enclave's signature over it
    /// (the HTTPS path to the enclave). Attach 0.01 NEAR for the deal's storage.
    #[payable]
    pub fn submit_match(&mut self, result: MatchResult, signature: Base64VecU8) -> U64 {
        let key = self.enclave_key.unwrap_or_else(|| env::panic_str("No enclave key yet"));
        let sig: [u8; 64] = signature.0.as_slice().try_into().unwrap_or_else(|_| env::panic_str("Signature is 64 bytes"));
        require!(env::ed25519_verify(&sig, result.signing_bytes(&env::current_account_id()), &key), "Not signed by the matcher enclave");
        require!(env::attached_deposit() >= DEAL_STORAGE, "Attach 0.01 NEAR for the deal's storage");
        let rfq_id = result.rfq_id;
        self.accept_match(result, rfq_id, "enclave_signature").unwrap_or_else(|e| env::panic_str(&e))
    }

    // ---------- settlement ----------

    /// Settle a matched deal's two pool legs in one call. Anyone may send it (the
    /// relayer normally does): the legs are bound to this deal, so only the two
    /// parties can have made them. Attach NEAR for the pool's storage (0.02 is plenty);
    /// the pool refunds what it does not use to the desk, not to the sender (a known,
    /// small leftover that stays with the desk).
    #[payable]
    pub fn settle(&mut self, deal_id: U64, legs: Value) -> Promise {
        let deal = self.deals.get_mut(&deal_id.0).unwrap_or_else(|| env::panic_str("No such deal"));
        require!(deal.status == DealStatus::Matched, "The deal is not waiting for settlement");
        require!(deal.class != SettlementClass::AtomicIntents, "This deal settles on NEAR Intents");
        require!(now_ms() <= deal.expires_at_ms.0, "The deal has expired");
        // one settlement in flight: no second settle, no expiry until the pool answers
        deal.status = DealStatus::Settling;
        deal.settle_attempts += 1;
        let args = json!({ "deal_id": deal_id, "legs": legs }).to_string().into_bytes();
        Promise::new(self.config.pool.clone())
            .function_call("settle_swap", args, env::attached_deposit(), GAS_POOL_SETTLE)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_ON_SETTLED).on_settled(deal_id))
    }

    #[private]
    pub fn on_settled(&mut self, deal_id: U64, #[callback_result] result: Result<Value, PromiseError>) -> bool {
        let deal = self.deals.get_mut(&deal_id.0).unwrap_or_else(|| env::panic_str("No such deal"));
        require!(deal.status == DealStatus::Settling, "The deal is not settling");
        let Ok(inserted) = result else {
            // A bad submission does not end the deal: the parties can still settle before expiry.
            deal.status = DealStatus::Matched;
            events::emit("settle_failed", json!({ "deal_id": deal_id }));
            return false;
        };
        let deal = deal.clone();
        let mut evidence = vec![Evidence { kind: "pool_settlement".into(), reference: format!("{}#{}", self.config.pool, inserted["leaf_index"].as_str().unwrap_or("?")) }];
        evidence.push(Evidence { kind: "pool_root".into(), reference: inserted["root"].as_str().unwrap_or("").into() });
        if deal.class == SettlementClass::BondedHedge {
            let d = self.deals.get_mut(&deal_id.0).unwrap();
            d.status = DealStatus::HedgePending;
            d.receipt = Some(Receipt { outcome: Outcome::Unresolved, evidence, recorded_at_ms: U64(now_ms()) });
            events::emit("spot_settled", json!({ "deal_id": deal_id, "hedge_path": hedge::derivation_path(deal_id.0) }));
        } else {
            self.release_bond(deal_id.0);
            self.close(deal_id.0, Outcome::Settled, evidence);
        }
        true
    }

    /// Mark a deal that ran out of time. Its bond is released (no one can tell which
    /// side failed to settle) and the receipt says it failed.
    pub fn expire(&mut self, deal_id: U64) {
        let deal = self.deals.get(&deal_id.0).cloned().unwrap_or_else(|| env::panic_str("No such deal"));
        require!(deal.status == DealStatus::Matched, "Only an unsettled deal expires");
        require!(now_ms() > deal.expires_at_ms.0, "Not expired yet");
        self.release_bond(deal_id.0);
        self.close(deal_id.0, Outcome::Failed, vec![Evidence { kind: "expired".into(), reference: format!("not settled by {}", deal.expires_at_ms.0) }]);
    }

    /// An `atomic_intents` deal settled on NEAR Intents: the keeper records the
    /// Intents transaction (on mainnet) as the receipt's evidence.
    pub fn record_intents_settlement(&mut self, deal_id: U64, tx_hash: String) {
        self.assert_keeper();
        let deal = self.deals.get(&deal_id.0).cloned().unwrap_or_else(|| env::panic_str("No such deal"));
        require!(deal.class == SettlementClass::AtomicIntents && deal.status == DealStatus::Matched, "Not an open Intents deal");
        self.release_bond(deal_id.0);
        self.close(deal_id.0, Outcome::Settled, vec![Evidence { kind: "intents_tx".into(), reference: tx_hash }]);
    }

    // ---------- the hedge leg ----------

    /// Have the MPC sign the deal's Hyperliquid order with the deal's own address.
    /// The order is rebuilt here from the deal's spec: IOC, the package's side, size
    /// and limit, nonce = this block's time. The keeper or the deal's maker asks; one
    /// opening order at a time, signed again only after the keeper reports it missed,
    /// at most `MAX_HEDGE_ATTEMPTS` times.
    pub fn sign_hedge_order(&mut self, deal_id: U64) -> Promise {
        let caller = env::predecessor_account_id();
        let keeper = self.config.keeper.clone();
        let deal = self.deals.get_mut(&deal_id.0).unwrap_or_else(|| env::panic_str("No such deal"));
        require!(caller == keeper || caller == deal.maker, "Only the keeper or the deal's maker");
        require!(deal.status == DealStatus::HedgePending, "The spot leg must settle first");
        require!(deal.hedge_orders == 0, "The hedge order was already signed");
        require!(deal.hedge_attempts < MAX_HEDGE_ATTEMPTS, "No hedge attempts left");
        let spec = deal.hedge.clone().unwrap();
        require!(now_ms() <= spec.deadline_ms, "Past the hedge deadline");
        deal.hedge_orders += 1;
        deal.hedge_attempts += 1;
        self.mpc_sign(deal_id, spec, false)
    }

    /// The trader closes the hedge: a reduce-only IOC the other way, signed by the
    /// MPC once the trader's per-deal key signs "hushd.close:<desk account>:<deal id>".
    pub fn close_hedge(&mut self, deal_id: U64, signature: Base64VecU8) -> Promise {
        let deal = self.deals.get_mut(&deal_id.0).unwrap_or_else(|| env::panic_str("No such deal"));
        require!(deal.status == DealStatus::Closed && deal.hedge.is_some(), "Only a finished hedge deal closes");
        require!(deal.hedge_orders == 1, "Already closed, or never opened");
        let key = deal.owner_key.clone().unwrap_or_else(|| env::panic_str("This deal has no owner key"));
        let pk = ed25519_key(&key).unwrap_or_else(|| env::panic_str("Owner key is ed25519"));
        let sig: [u8; 64] = signature.0.as_slice().try_into().unwrap_or_else(|_| env::panic_str("Signature is 64 bytes"));
        let message = format!("hushd.close:{}:{}", env::current_account_id(), deal_id.0);
        require!(env::ed25519_verify(&sig, message.as_bytes(), &pk), "Not signed by the deal's owner");
        deal.hedge_orders += 1;
        let spec = deal.hedge.clone().unwrap();
        self.mpc_sign(deal_id, spec, true)
    }

    #[private]
    pub fn on_hedge_signed(&mut self, deal_id: U64, nonce: U64, close: bool, #[callback_result] result: Result<Value, PromiseError>) -> Option<Value> {
        match result {
            Ok(sig) => {
                events::emit("hedge_signed", json!({ "deal_id": deal_id, "nonce": nonce, "close": close, "signature": sig }));
                Some(json!({ "nonce": nonce, "signature": sig }))
            }
            Err(_) => {
                // nothing was signed: the order (and the attempt) can be asked for again
                if let Some(d) = self.deals.get_mut(&deal_id.0) {
                    d.hedge_orders = d.hedge_orders.saturating_sub(1);
                    if !close {
                        d.hedge_attempts = d.hedge_attempts.saturating_sub(1);
                    }
                }
                events::emit("hedge_sign_failed", json!({ "deal_id": deal_id }));
                None
            }
        }
    }

    /// The keeper reports the Hyperliquid leg: filled (with the fill as evidence), or
    /// missed. A miss before the deadline lets the order be signed again, up to
    /// `MAX_HEDGE_ATTEMPTS` times; the last miss, or one past the deadline, slashes
    /// the maker's bond to the trader.
    pub fn record_hedge(&mut self, deal_id: U64, filled: bool, evidence: Vec<Evidence>) -> PromiseOrValue<()> {
        self.assert_keeper();
        let deal = self.deals.get(&deal_id.0).cloned().unwrap_or_else(|| env::panic_str("No such deal"));
        require!(deal.status == DealStatus::HedgePending, "No open hedge leg");
        let mut all = deal.receipt.clone().map(|r| r.evidence).unwrap_or_default();
        all.extend(evidence);
        if filled {
            self.release_bond(deal_id.0);
            self.close(deal_id.0, Outcome::Settled, all);
            return PromiseOrValue::Value(());
        }
        let deadline = deal.hedge.as_ref().unwrap().deadline_ms;
        if now_ms() <= deadline && deal.hedge_attempts < MAX_HEDGE_ATTEMPTS {
            let d = self.deals.get_mut(&deal_id.0).unwrap();
            d.hedge_orders = 0;
            d.receipt = Some(Receipt { outcome: Outcome::Unresolved, evidence: all, recorded_at_ms: U64(now_ms()) });
            events::emit("hedge_retry", json!({ "deal_id": deal_id, "attempts": d.hedge_attempts, "max_attempts": MAX_HEDGE_ATTEMPTS }));
            return PromiseOrValue::Value(());
        }
        PromiseOrValue::Promise(self.slash(deal_id.0, all))
    }

    /// Anyone may slash a hedge leg that is past its deadline with nothing recorded.
    pub fn slash_overdue(&mut self, deal_id: U64) -> Promise {
        let deal = self.deals.get(&deal_id.0).cloned().unwrap_or_else(|| env::panic_str("No such deal"));
        require!(deal.status == DealStatus::HedgePending, "No open hedge leg");
        require!(now_ms() > deal.hedge.as_ref().unwrap().deadline_ms, "The hedge deadline has not passed");
        let mut all = deal.receipt.clone().map(|r| r.evidence).unwrap_or_default();
        all.push(Evidence { kind: "hedge_overdue".into(), reference: format!("no fill by {}", deal.hedge.as_ref().unwrap().deadline_ms) });
        self.slash(deal_id.0, all)
    }

    /// Anyone may send a slashed bond the pool refused (deposits paused, a limit) to the
    /// pool again, as the same note for the trader.
    pub fn retry_slash_payout(&mut self, deal_id: U64) -> Promise {
        let d = self.deals.get_mut(&deal_id.0).unwrap_or_else(|| env::panic_str("No such deal"));
        require!(d.status == DealStatus::SlashRefused, "No refused slash payout on this deal");
        d.status = DealStatus::Slashing;
        let (inner, amount) = (d.trader_inner.clone().unwrap(), d.slash_held.0);
        events::emit("slash_retried", json!({ "deal_id": deal_id, "amount": U128(amount) }));
        self.pay_slash(deal_id.0, inner, amount)
    }

    #[private]
    pub fn on_slash_paid(&mut self, deal_id: U64, amount: U128) {
        // ft_transfer_call returns what the pool kept: all of it, or nothing when the pool
        // refused the shield. Only a failed call kept nothing for sure; a success the desk
        // cannot read counts as kept, so a payout is never sent twice.
        let kept = match env::promise_result_checked(0, 64) {
            Err(PromiseError::Failed) => 0,
            Ok(v) => serde_json::from_slice::<U128>(&v).map_or(amount.0, |u| u.0.min(amount.0)),
            Err(_) => amount.0,
        };
        let d = self.deals.get_mut(&deal_id.0).unwrap_or_else(|| env::panic_str("No such deal"));
        require!(d.status == DealStatus::Slashing, "The deal is not slashing");
        let mut evidence = d.receipt.take().map(|r| r.evidence).unwrap_or_default();
        if kept > 0 {
            evidence.push(Evidence { kind: "bond_paid_privately".into(), reference: format!("{kept} to a pool note") });
        }
        let held = amount.0 - kept;
        d.slash_held = U128(held);
        self.stats.slashed = U128(self.stats.slashed.0 + kept);
        if held == 0 {
            self.close(deal_id.0, Outcome::Recovered, evidence);
            return;
        }
        // the desk keeps the rest for the trader; it is no longer part of the maker's bond
        evidence.retain(|e| e.kind != "bond_payout_returned");
        evidence.push(Evidence { kind: "bond_payout_returned".into(), reference: format!("{held} held by the desk until retry_slash_payout") });
        let d = self.deals.get_mut(&deal_id.0).unwrap();
        d.status = DealStatus::SlashRefused;
        d.receipt = Some(Receipt { outcome: Outcome::Unresolved, evidence, recorded_at_ms: U64(now_ms()) });
        events::emit("slash_refused", json!({ "deal_id": deal_id, "held": U128(held) }));
    }

    // ---------- owner ----------
    // The pool, the bond token and the MPC never change. Everything else changes through
    // a proposal that waits out `config_timelock_ns`, so makers can withdraw first.

    /// Propose new settings. Owner only, attach 1 yoctoNEAR. One proposal at a time.
    #[payable]
    pub fn propose_config(&mut self, change: ConfigChange) -> U64 {
        assert_one_yocto();
        self.assert_owner();
        require!(self.pending_config.is_none(), "A config change is already pending; cancel it first");
        require!(change.matcher_project.len() <= 128, "matcher_project too long");
        let id = self.next_config_change;
        self.next_config_change += 1;
        let p = PendingConfig { id: U64(id), change, apply_after_ns: U64(env::block_timestamp().saturating_add(self.config.config_timelock_ns.0)) };
        events::emit("config_change", json!({ "id": p.id, "status": "proposed", "apply_after_ns": p.apply_after_ns, "change": p.change }));
        self.pending_config = Some(p);
        U64(id)
    }

    /// Apply the pending proposal `id` once its timelock has passed. Owner only, attach 1 yoctoNEAR.
    #[payable]
    pub fn apply_config(&mut self, id: U64) {
        assert_one_yocto();
        self.assert_owner();
        let p = self.pending_config.take().filter(|p| p.id == id).unwrap_or_else(|| env::panic_str("No such pending change"));
        require!(env::block_timestamp() >= p.apply_after_ns.0, "The timelock has not passed");
        let c = p.change.clone();
        self.config = Config {
            owner: c.owner,
            outlayer: c.outlayer,
            matcher_project: c.matcher_project,
            secrets_owner: c.secrets_owner,
            keeper: c.keeper,
            outlayer_fee: c.outlayer_fee,
            min_bond: c.min_bond,
            ..self.config.clone()
        };
        events::emit("config_change", json!({ "id": p.id, "status": "applied", "apply_after_ns": p.apply_after_ns, "change": p.change }));
    }

    /// Drop the pending proposal `id`. Owner only, attach 1 yoctoNEAR.
    #[payable]
    pub fn cancel_config(&mut self, id: U64) {
        assert_one_yocto();
        self.assert_owner();
        let p = self.pending_config.take().filter(|p| p.id == id).unwrap_or_else(|| env::panic_str("No such pending change"));
        events::emit("config_change", json!({ "id": p.id, "status": "cancelled", "apply_after_ns": p.apply_after_ns, "change": p.change }));
    }

    // ---------- views ----------

    pub fn config(&self) -> Config {
        self.config.clone()
    }

    pub fn pending_config(&self) -> Option<PendingConfig> {
        self.pending_config.clone()
    }

    pub fn enclave(&self) -> Value {
        json!({
            "sign_key": self.enclave_key.map(|k| format!("0x{}", hex::encode(k))),
            "enc_key": self.enclave_enc_key,
            "project": self.config.matcher_project,
        })
    }

    pub fn makers(&self) -> Vec<(AccountId, Maker)> {
        self.makers.iter().map(|(a, m)| (a.clone(), m.clone())).collect()
    }

    pub fn maker(&self, account_id: AccountId) -> Option<Maker> {
        self.makers.get(&account_id).cloned()
    }

    pub fn rfq(&self, rfq_id: U64) -> Option<Rfq> {
        self.rfqs.get(&rfq_id.0).cloned()
    }

    pub fn deal(&self, deal_id: U64) -> Option<Deal> {
        self.deals.get(&deal_id.0).cloned()
    }

    /// Deals newest first.
    pub fn deals(&self, from_index: Option<U64>, limit: Option<u32>) -> Vec<Deal> {
        let start = from_index.map(|f| f.0).unwrap_or(self.next_deal);
        let limit = limit.unwrap_or(20).min(100) as u64;
        (0..start).rev().take(limit as usize).filter_map(|i| self.deals.get(&i).cloned()).collect()
    }

    pub fn stats(&self) -> Stats {
        self.stats.clone()
    }

    pub fn hedge_path(&self, deal_id: U64) -> String {
        hedge::derivation_path(deal_id.0)
    }

    /// The EIP-712 digest the MPC signs for a deal's order at `nonce` (for checking).
    pub fn hedge_digest(&self, deal_id: U64, nonce: U64, close: bool) -> String {
        let deal = self.deals.get(&deal_id.0).unwrap_or_else(|| env::panic_str("No such deal"));
        let spec = deal.hedge.as_ref().unwrap_or_else(|| env::panic_str("No hedge leg"));
        hex::encode(hedge::order_digest(spec, nonce.0, close))
    }

    // ---------- internals ----------

    fn assert_keeper(&self) {
        require!(env::predecessor_account_id() == self.config.keeper, "Keeper only");
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.config.owner, "Owner only");
    }

    fn outlayer_call(&self, input: String, fee: NearToken) -> Promise {
        ext_outlayer::ext(self.config.outlayer.clone())
            .with_attached_deposit(fee)
            .with_static_gas(Gas::from_tgas(60))
            .with_unused_gas_weight(1)
            .request_execution(
                json!({ "Project": { "project_id": self.config.matcher_project } }),
                json!({ "max_instructions": 10_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 60 }),
                input,
                Some(json!({ "profile": "default", "account_id": self.config.secrets_owner })),
                "Json".into(),
                Some(env::predecessor_account_id()),
            )
    }

    /// OutLayer resumes with `{"success": bool, "result": ..., "error": ...}`.
    fn outlayer_output(result: Result<Option<String>, PromiseError>) -> Result<Value, String> {
        let text = result.map_err(|_| "OutLayer execution failed".to_string())?.ok_or("Empty OutLayer result")?;
        let v: Value = serde_json::from_str(&text).map_err(|_| "Unreadable OutLayer result".to_string())?;
        if v.get("success") == Some(&json!(false)) {
            return Err(format!("Matcher error: {}", v["error"].as_str().unwrap_or("unknown")));
        }
        Ok(v.get("result").cloned().unwrap_or(v))
    }

    fn accept_match(&mut self, m: MatchResult, rfq_id: U64, attested_by: &str) -> Result<U64, String> {
        if m.rfq_id != rfq_id {
            return Err("The match is for another RFQ".into());
        }
        let rfq = self.rfqs.get(&rfq_id.0).cloned().ok_or("No such RFQ")?;
        if rfq.deal_id.is_some() {
            return Err("This RFQ already has a deal".into());
        }
        if now_ms() > rfq.closes_at_ms.0.saturating_add(MATCH_GRACE_MS) {
            return Err("The RFQ closed too long ago to be matched".into());
        }
        if parse_hex32(&m.terms_hash).is_none() {
            return Err("terms_hash is 0x hex, 32 bytes".into());
        }
        if m.expires_at_ms.0 <= now_ms() {
            return Err("The match has already expired".into());
        }
        match m.class {
            SettlementClass::BondedHedge => {
                let h = m.hedge.as_ref().ok_or("A bonded hedge deal names its hedge")?;
                if !hedge::valid_wire_decimal(&h.size) || !hedge::valid_wire_decimal(&h.limit_px) {
                    return Err("Hedge size and price must be wire decimals".into());
                }
                if h.deadline_ms <= m.expires_at_ms.0 {
                    return Err("The hedge deadline must come after the deal's expiry".into());
                }
                // checked the way the pool reads it, so a slash payout cannot be refused for it
                if m.trader_inner.as_deref().and_then(parse_field_hex).is_none() {
                    return Err("A bonded deal names the trader's payout note (a nonzero field element, 0x and 64 hex digits)".into());
                }
                if m.bond.0 == 0 || m.bond.0 < self.config.min_bond.0 {
                    return Err("The bond is below the desk minimum".into());
                }
            }
            _ => {
                if m.hedge.is_some() {
                    return Err("Only bonded hedge deals carry a hedge".into());
                }
            }
        }
        let consent = m.consent_bytes(&env::current_account_id()).ok_or("terms_hash is 0x hex, 32 bytes")?;
        let maker = self.makers.get_mut(&m.maker).ok_or("The maker is not registered")?;
        let quote_key = ed25519_key(&maker.quote_key).ok_or("The maker's quote key is unreadable")?;
        let sig: [u8; 64] = m.maker_sig.0.as_slice().try_into().map_err(|_| "The maker's signature is 64 bytes")?;
        if !env::ed25519_verify(&sig, &consent, &quote_key) {
            return Err("The maker did not sign these terms".into());
        }
        if !maker.active {
            return Err("The maker is paused".into());
        }
        if maker.bond.0 - maker.locked.0 < m.bond.0 {
            return Err("The maker's free bond does not cover this deal".into());
        }
        maker.locked = U128(maker.locked.0 + m.bond.0);
        maker.deals += 1;

        let id = self.next_deal;
        self.next_deal += 1;
        let deal = Deal {
            id: U64(id),
            rfq_id,
            maker: m.maker,
            terms_hash: m.terms_hash,
            class: m.class,
            matched_at_ms: U64(now_ms()),
            expires_at_ms: m.expires_at_ms,
            bond: m.bond,
            trader_inner: m.trader_inner,
            owner_key: m.owner_key,
            hedge: m.hedge,
            status: DealStatus::Matched,
            settle_attempts: 0,
            hedge_orders: 0,
            hedge_attempts: 0,
            bond_released: false,
            slash_held: U128(0),
            attested_by: attested_by.into(),
            receipt: None,
        };
        events::emit(
            "deal_matched",
            json!({ "deal_id": U64(id), "rfq_id": rfq_id, "maker": deal.maker, "class": deal.class, "terms_hash": deal.terms_hash,
                    "expires_at_ms": deal.expires_at_ms, "bond": deal.bond, "hedge": deal.hedge, "attested_by": attested_by }),
        );
        self.deals.insert(id, deal);
        self.rfqs.get_mut(&rfq_id.0).unwrap().deal_id = Some(U64(id));
        self.stats.deals += 1;
        Ok(U64(id))
    }

    fn mpc_sign(&self, deal_id: U64, spec: HedgeSpec, close: bool) -> Promise {
        let nonce = now_ms();
        let digest = hedge::order_digest(&spec, nonce, close);
        let args = json!({
            "request": {
                "path": hedge::derivation_path(deal_id.0),
                "payload_v2": { "Ecdsa": hex::encode(digest) },
                "domain_id": 0,
            }
        })
        .to_string()
        .into_bytes();
        Promise::new(self.config.mpc.clone())
            .function_call("sign", args, ONE_YOCTO, GAS_MPC)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_hedge_signed(deal_id, U64(nonce), close))
    }

    /// Take the deal's locked bond from its maker and pay it into the pool as a note for
    /// the trader. The deal is `Slashing` until the pool answers, so it is slashed once.
    fn slash(&mut self, deal_id: u64, evidence: Vec<Evidence>) -> Promise {
        let (maker_id, amount) = self.release_bond(deal_id);
        let maker = self.makers.get_mut(&maker_id).unwrap_or_else(|| env::panic_str(BOND_BUG));
        maker.bond = U128(maker.bond.0.checked_sub(amount).unwrap_or_else(|| env::panic_str(BOND_BUG)));
        maker.slashed = U128(maker.slashed.0 + amount);
        let d = self.deals.get_mut(&deal_id).unwrap();
        d.status = DealStatus::Slashing;
        d.slash_held = U128(amount);
        d.receipt = Some(Receipt { outcome: Outcome::Unresolved, evidence, recorded_at_ms: U64(now_ms()) });
        let inner = d.trader_inner.clone().unwrap();
        events::emit("bond_slashed", json!({ "deal_id": U64(deal_id), "maker": maker_id, "amount": U128(amount) }));
        self.pay_slash(deal_id, inner, amount)
    }

    fn pay_slash(&self, deal_id: u64, inner: String, amount: u128) -> Promise {
        let msg = json!({ "inner": inner }).to_string();
        ext_ft::ext(self.config.bond_token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_CALL)
            .ft_transfer_call(self.config.pool.clone(), U128(amount), Some("Hushd bond slash".into()), msg)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_slash_paid(U64(deal_id), U128(amount)))
    }

    /// Release the deal's bond from its maker's locked bond, exactly once per deal.
    /// Returns the maker and the amount. Any mismatch is an accounting bug and panics.
    fn release_bond(&mut self, deal_id: u64) -> (AccountId, u128) {
        let d = self.deals.get_mut(&deal_id).unwrap_or_else(|| env::panic_str("No such deal"));
        require!(!d.bond_released, "This deal's bond was already released");
        d.bond_released = true;
        let (maker, amount) = (d.maker.clone(), d.bond.0);
        if amount > 0 {
            let m = self.makers.get_mut(&maker).unwrap_or_else(|| env::panic_str(BOND_BUG));
            m.locked = U128(m.locked.0.checked_sub(amount).unwrap_or_else(|| env::panic_str(BOND_BUG)));
        }
        (maker, amount)
    }

    fn close(&mut self, deal_id: u64, outcome: Outcome, evidence: Vec<Evidence>) {
        let d = self.deals.get_mut(&deal_id).unwrap();
        d.status = DealStatus::Closed;
        let receipt = Receipt { outcome, evidence, recorded_at_ms: U64(now_ms()) };
        events::emit("receipt", json!({ "deal_id": U64(deal_id), "maker": d.maker, "class": d.class, "receipt": receipt }));
        d.receipt = Some(receipt);
        match outcome {
            Outcome::Settled => self.stats.settled += 1,
            Outcome::Recovered => self.stats.recovered += 1,
            Outcome::Failed => self.stats.failed += 1,
            Outcome::Unresolved => self.stats.unresolved += 1,
        }
    }

    /// Charge the caller for storage this call added, from the deposit attached.
    fn charge_storage(&mut self, before: u64) {
        let added = env::storage_usage().saturating_sub(before) as u128;
        let cost = env::storage_byte_cost().saturating_mul(added);
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("Attach at least {} yoctoNEAR for storage", cost.as_yoctonear()));
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            let _ = Promise::new(env::predecessor_account_id()).transfer(refund);
        }
    }
}

#[near]
impl FungibleTokenReceiver for Desk {
    /// Bonds: a registered maker sends the bond token with msg "bond".
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.config.bond_token || msg != "bond" {
            return PromiseOrValue::Value(amount);
        }
        let Some(m) = self.makers.get_mut(&sender_id) else {
            return PromiseOrValue::Value(amount);
        };
        m.bond = U128(m.bond.0 + amount.0);
        events::emit("bond_posted", json!({ "maker": sender_id, "amount": amount, "bond": m.bond }));
        PromiseOrValue::Value(U128(0))
    }
}

#[cfg(test)]
mod tests;
