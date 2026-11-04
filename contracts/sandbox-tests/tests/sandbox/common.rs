//! The harness every test shares: a fresh local nearcore per test, the prebuilt
//! wasm, the proof fixture, small call helpers and a gas table.
//!
//! The wasm files are read from `contracts/target/near/<crate>/<crate>.wasm`.
//! Build them first, from `contracts/`:
//!
//! ```text
//! for d in pool token desk sandbox-tests/doubles/outlayer sandbox-tests/doubles/mpc; do
//!   (cd $d && cargo near build non-reproducible-wasm)
//! done
//! ```

use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, Chain, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::Sandbox;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use testresult::TestResult;

/// Real Groth16 proofs made with the dev keys by `circuits/scripts/gen-fixtures.mjs`.
pub const FIXTURE: &str = include_str!("../../../pool/tests/fixtures.json");

/// Prepaid gas for every call. The static promise budgets set the floor: a cash out
/// needs about 143 Tgas, `request_match` about 105 and a desk `settle` about 200.
pub const GAS: NearGas = NearGas::from_tgas(300);
/// Storage a transact may need; what is not used comes back to the caller.
pub const STORAGE: NearToken = NearToken::from_millinear(50);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

// ---------- wasm ----------

pub struct Wasm {
    crate_name: &'static str,
    dir: &'static str,
}

pub const POOL: Wasm = Wasm { crate_name: "hushd_pool", dir: "pool" };
pub const TOKEN: Wasm = Wasm { crate_name: "hushd_token", dir: "token" };
pub const DESK: Wasm = Wasm { crate_name: "hushd_desk", dir: "desk" };
pub const OUTLAYER_DOUBLE: Wasm = Wasm { crate_name: "outlayer_double", dir: "sandbox-tests/doubles/outlayer" };
pub const MPC_DOUBLE: Wasm = Wasm { crate_name: "mpc_double", dir: "sandbox-tests/doubles/mpc" };

impl Wasm {
    /// The prebuilt file, or a panic that says how to build it.
    pub fn read(&self) -> Vec<u8> {
        let target = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target"));
        let path = target.join("near").join(self.crate_name).join(format!("{}.wasm", self.crate_name));
        std::fs::read(&path).unwrap_or_else(|e| {
            panic!(
                "{} is missing ({e}).\nBuild it first: cd contracts/{} && cargo near build non-reproducible-wasm",
                path.display(),
                self.dir
            )
        })
    }
}

// ---------- the sandbox ----------

pub struct Env {
    /// Kept alive for the whole test: dropping it stops the node and deletes its home.
    pub sandbox: Sandbox,
    pub net: NetworkConfig,
    signer: Arc<Signer>,
}

impl Env {
    pub async fn start() -> TestResult<Self> {
        let sandbox = Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        // Accounts made with `create_account` get the genesis key, so one signer signs for all.
        let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
        Ok(Self { sandbox, net, signer })
    }

    /// A sub-account of the genesis account (`<name>.sandbox`) with 100 NEAR.
    pub async fn account(&self, name: &str) -> TestResult<AccountId> {
        let id: AccountId = format!("{name}.{}", near_sandbox::config::DEFAULT_GENESIS_ACCOUNT).parse()?;
        self.sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(100)).send().await?;
        Ok(id)
    }

    /// Create `<name>.sandbox`, deploy `wasm` there and call `new(args)` in the same transaction.
    pub async fn deploy(&self, name: &str, wasm: &Wasm, args: Value) -> TestResult<(AccountId, ExecutionFinalResult)> {
        let id = self.account(name).await?;
        let result = Contract::deploy(id.clone())
            .use_code(wasm.read())
            .with_init_call("new", args)?
            .gas(GAS)
            .with_signer(self.signer.clone())
            .send_to(&self.net)
            .await?
            .into_full()
            .ok_or("deploy did not finish")?;
        assert_ok(&result, &format!("deploy {name}"));
        Ok((id, result))
    }

    /// A function call transaction with 300 Tgas; the caller checks the outcome.
    pub async fn call(
        &self,
        signer: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> TestResult<ExecutionFinalResult> {
        let result = Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(GAS)
            .with_signer(signer.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?
            .into_full()
            .ok_or("transaction did not finish")?;
        Ok(result)
    }

    /// Like `call`, and the transaction and every receipt must succeed.
    pub async fn call_ok(
        &self,
        signer: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> TestResult<ExecutionFinalResult> {
        let result = self.call(signer, contract, method, args, deposit).await?;
        assert_ok(&result, method);
        Ok(result)
    }

    /// A view call; the result as JSON.
    pub async fn view(&self, contract: &AccountId, method: &str, args: Value) -> TestResult<Value> {
        Ok(Contract(contract.clone()).call_function(method, args).read_only::<Value>().fetch_from(&self.net).await?.data)
    }

    /// The latest block's timestamp in ms.
    pub async fn now_ms(&self) -> TestResult<u64> {
        let block = Chain::block().fetch_from(&self.net).await?;
        Ok(block.header.timestamp_nanosec.parse::<u64>()? / 1_000_000)
    }

    pub async fn ft_balance(&self, token: &AccountId, account: &AccountId) -> TestResult<u128> {
        let v = self.view(token, "ft_balance_of", json!({ "account_id": account })).await?;
        Ok(s(&v).parse()?)
    }
}

// ---------- outcomes ----------

/// Every failed receipt as "executor: error".
pub fn failures(r: &ExecutionFinalResult) -> Vec<String> {
    r.failures()
        .into_iter()
        .map(|o| format!("{}: {:?}", o.executor_id, o.clone().into_result().err()))
        .collect()
}

/// The transaction and all its receipts succeeded.
pub fn assert_ok(r: &ExecutionFinalResult, what: &str) {
    let f = failures(r);
    assert!(r.is_success() && f.is_empty(), "{what} failed:\n{}\nlogs: {:#?}", f.join("\n"), r.logs());
}

/// NEP-297 events in the logs, as (event name, first data item).
pub fn events(r: &ExecutionFinalResult) -> Vec<(String, Value)> {
    r.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .map(|e| (e["event"].as_str().unwrap_or("").to_string(), e["data"][0].clone()))
        .collect()
}

pub fn event(r: &ExecutionFinalResult, name: &str) -> Option<Value> {
    events(r).into_iter().find(|(n, _)| n == name).map(|(_, d)| d)
}

/// Gas burnt by the receipts that ran on `account` (summed).
pub fn burnt_on(r: &ExecutionFinalResult, account: &AccountId) -> NearGas {
    NearGas::from_gas(r.receipt_outcomes().iter().filter(|o| &o.executor_id == account).map(|o| o.gas_burnt.as_gas()).sum())
}

// ---------- the gas table ----------

struct Row {
    label: String,
    total: NearGas,
    receipts: Vec<(AccountId, NearGas)>,
}

/// Gas burnt per timed transaction: the total and each receipt's share.
pub struct GasTable {
    title: String,
    rows: Vec<Row>,
}

fn tgas(g: NearGas) -> String {
    format!("{:.2}", g.as_gas() as f64 / 1e12)
}

impl GasTable {
    pub fn new(title: &str) -> Self {
        Self { title: title.into(), rows: Vec::new() }
    }

    pub fn add(&mut self, label: &str, r: &ExecutionFinalResult) {
        let mut receipts = vec![(r.outcome().executor_id.clone(), r.outcome().gas_burnt)];
        receipts.extend(r.receipt_outcomes().iter().filter(|o| o.gas_burnt.as_gas() > 0).map(|o| (o.executor_id.clone(), o.gas_burnt)));
        self.rows.push(Row { label: label.into(), total: r.total_gas_burnt, receipts });
    }

    fn print(&self) {
        let w = self.rows.iter().map(|r| r.label.len()).max().unwrap_or(4).max(4);
        println!("\n=== gas: {} ===", self.title);
        println!("{:<w$} | {:>10} | per receipt, in order (account: Tgas)", "call", "total Tgas");
        println!("{}-+-{}-+-{}", "-".repeat(w), "-".repeat(10), "-".repeat(40));
        for r in &self.rows {
            let parts: Vec<String> = r.receipts.iter().map(|(a, g)| format!("{}: {}", short(a), tgas(*g))).collect();
            println!("{:<w$} | {:>10} | {}", r.label, tgas(r.total), parts.join(", "));
        }
        println!();
    }
}

/// The table prints when the test's world goes away, also after a failed assertion.
impl Drop for GasTable {
    fn drop(&mut self) {
        if !self.rows.is_empty() {
            self.print();
        }
    }
}

fn short(a: &AccountId) -> &str {
    a.as_str().strip_suffix(".sandbox").unwrap_or(a.as_str())
}

// ---------- the fixture ----------

pub fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("fixtures.json")
}

pub fn s(v: &Value) -> String {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}")).to_string()
}

/// A decimal field element (as snarkjs prints it) in the pool's view format: 0x, 64 hex digits.
pub fn hex(decimal: &str) -> String {
    let mut out = [0u8; 32];
    for b in decimal.bytes() {
        assert!(b.is_ascii_digit(), "not a decimal: {decimal}");
        let mut carry = (b - b'0') as u32;
        for byte in out.iter_mut().rev() {
            let v = (*byte as u32) * 10 + carry;
            *byte = (v & 0xff) as u8;
            carry = v >> 8;
        }
        assert_eq!(carry, 0, "above 2^256: {decimal}");
    }
    format!("0x{}", out.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// `ft_transfer_call` msg for a shield step: `{"inner": "<field>"}`.
pub fn shield_msg(step: &Value) -> String {
    json!({ "inner": s(&step["inner"]) }).to_string()
}

/// `transact` args for the private send.
pub fn send_args(f: &Value) -> Value {
    let st = &f["send"];
    json!({
        "proof": st["proof"],
        "args": { "root": st["root"], "nullifiers": st["nullifiers"], "commitments": st["commitments"] },
    })
}

/// `transact` args for the cash out of 30 USDC to alice.sandbox, fee 1 to relayer.sandbox.
pub fn cash_out_args(f: &Value) -> Value {
    let st = &f["cashOut"];
    let e = &st["ext"];
    json!({
        "proof": st["proof"],
        "args": {
            "root": st["root"],
            "nullifiers": st["nullifiers"],
            "commitments": st["commitments"],
            "public_amount": st["publicAmount"],
            "token": f["tokens"]["usdc"],
            "ext": { "recipient": e["recipient"], "relayer": e["relayer"], "fee": e["fee"], "refund_inner": e["refund_inner"] },
        },
    })
}

/// One swap leg as the pool takes it: `{proof, root, nullifiers, commitments}`.
pub fn leg(v: &Value) -> Value {
    json!({ "proof": v["proof"], "root": v["root"], "nullifiers": v["nullifiers"], "commitments": v["commitments"] })
}

/// `verify_disclosure` args for one of the fixture's reader proofs.
pub fn disclosure_args(f: &Value, kind: &str) -> Value {
    let p = &f[kind];
    json!({ "kind": kind, "proof": p["proof"], "public_inputs": p["publicSignals"], "legs": p.get("legs") })
}

// ---------- the Hushd world ----------

/// Limits far above anything the fixture moves.
pub fn generous() -> Value {
    json!({ "per_deposit": "1000000000000", "total": "1000000000000000" })
}

/// The accounts the fixture names plus the ones the contracts need. Fixture ids:
/// usdc.sandbox, btc.sandbox, alice.sandbox (cash-out recipient), relayer.sandbox.
pub struct World {
    pub env: Env,
    pub gas: GasTable,
    pub owner: AccountId,
    pub relayer: AccountId,
    pub alice: AccountId,
    pub maker: AccountId,
    pub usdc: AccountId,
    pub btc: AccountId,
    pub pool: AccountId,
    pub f: Value,
}

impl World {
    /// A sandbox with both tokens deployed and the people's accounts created; no pool yet.
    pub async fn start(title: &str) -> TestResult<Self> {
        let env = Env::start().await?;
        let f = fixture();
        let owner = env.account("owner").await?;
        let relayer = env.account("relayer").await?;
        let alice = env.account("alice").await?;
        let maker = env.account("maker").await?;
        assert_eq!(s(&f["tokens"]["usdc"]), "usdc.sandbox");
        assert_eq!(s(&f["cashOut"]["ext"]["recipient"]), alice.as_str());
        assert_eq!(s(&f["cashOut"]["ext"]["relayer"]), relayer.as_str());
        let token_args = |name: &str, symbol: &str, decimals: u8| {
            json!({
                "owner_id": owner, "name": name, "symbol": symbol, "decimals": decimals, "icon": null,
                "faucet_amount": "1000", "faucet_cooldown_ns": "3600000000000",
            })
        };
        let (usdc, _) = env.deploy("usdc", &TOKEN, token_args("USD Coin (Hushd testnet)", "USDC", 6)).await?;
        let (btc, _) = env.deploy("btc", &TOKEN, token_args("Bitcoin (Hushd testnet)", "BTC", 8)).await?;
        let pool: AccountId = "pool.sandbox".parse()?;
        Ok(Self { env, gas: GasTable::new(title), owner, relayer, alice, maker, usdc, btc, pool, f })
    }

    /// Deploy the pool at pool.sandbox with both tokens listed and register it on both.
    pub async fn deploy_pool(&mut self, desk: Option<&AccountId>) -> TestResult<()> {
        let args = json!({
            "owner_id": self.owner,
            "desk_id": desk,
            "timelock_ns": "1000000000",
            "assets": [
                { "token": self.usdc, "limits": generous() },
                { "token": self.btc, "limits": generous() },
            ],
        });
        let (pool, r) = self.env.deploy("pool", &POOL, args).await?;
        assert_eq!(pool, self.pool);
        self.gas.add("deploy pool + new (empty tree)", &r);
        let (usdc, btc) = (self.usdc.clone(), self.btc.clone());
        self.register(&usdc, &pool).await?;
        self.register(&btc, &pool).await?;
        Ok(())
    }

    /// NEP-145 storage registration of `account` on `token`, paid by the owner.
    pub async fn register(&self, token: &AccountId, account: &AccountId) -> TestResult<()> {
        let args = json!({ "account_id": account, "registration_only": true });
        self.env.call_ok(&self.owner, token, "storage_deposit", args, NearToken::from_millinear(10)).await.map(drop)
    }

    pub async fn mint(&self, token: &AccountId, account: &AccountId, amount: u128) -> TestResult<()> {
        let args = json!({ "account_id": account, "amount": amount.to_string() });
        self.env.call_ok(&self.owner, token, "mint", args, NearToken::from_yoctonear(0)).await.map(drop)
    }

    /// Shield a fixture step (`shieldAlice` or `shieldMaker`): `from` sends the step's
    /// amount to the pool with the step's `inner`. The sender is not part of the note.
    pub async fn shield(&mut self, from: &AccountId, step: &str) -> TestResult<()> {
        let st = self.f[step].clone();
        let token: AccountId = s(&st["token"]).parse()?;
        let args = json!({ "receiver_id": self.pool, "amount": st["amount"], "memo": null, "msg": shield_msg(&st) });
        let r = self.env.call_ok(from, &token, "ft_transfer_call", args, ONE_YOCTO).await?;
        let ev = event(&r, "shield").unwrap_or_else(|| panic!("no shield event: {:#?}", r.logs()));
        assert_eq!(ev["commitment"], hex(&s(&st["commitment"])), "the pool computed another commitment");
        self.gas.add(&format!("shield ({step}, ft_transfer_call)"), &r);
        Ok(())
    }

    /// The private send, relayed by relayer.sandbox with 0.05 NEAR for storage.
    /// Returns what `transact` returned: the first new leaf and the new root.
    pub async fn send(&mut self) -> TestResult<Value> {
        let r = self.env.call_ok(&self.relayer, &self.pool, "transact", send_args(&self.f), STORAGE).await?;
        self.gas.add("private send (transact)", &r);
        Ok(r.json()?)
    }

    /// The cash out of 30 USDC, relayed by relayer.sandbox. Not every receipt has to
    /// succeed: the payout may fail and be refunded.
    pub async fn cash_out(&mut self, label: &str) -> TestResult<ExecutionFinalResult> {
        let r = self.env.call(&self.relayer, &self.pool, "transact", cash_out_args(&self.f), STORAGE).await?;
        assert!(r.is_success(), "transact failed: {:?}", failures(&r));
        self.gas.add(label, &r);
        Ok(r)
    }

    pub async fn root(&self) -> TestResult<String> {
        Ok(s(&self.env.view(&self.pool, "get_root", json!({})).await?))
    }

    pub async fn next_leaf_index(&self) -> TestResult<u64> {
        let v = self.env.view(&self.pool, "next_leaf_index", json!({})).await?;
        Ok(s(&v).parse()?)
    }

    pub async fn stats(&self) -> TestResult<Value> {
        self.env.view(&self.pool, "stats", json!({})).await
    }

    pub async fn held(&self, token: &AccountId) -> TestResult<u128> {
        let assets = self.env.view(&self.pool, "assets", json!({})).await?;
        let a = assets.as_array().ok_or("assets is a list")?.iter().find(|a| a["token"] == token.as_str()).ok_or("token not listed")?;
        Ok(s(&a["held"]).parse()?)
    }
}
