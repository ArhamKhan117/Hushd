//! Static checks for Hushd's NEAR contracts.
//!
//! Parses each contract's Rust source with `syn` and runs the detector classes of the
//! near-contract-audit checklist, which are the classes BlockSec's Rustle reports. Rustle
//! itself needs LLVM 15 and cannot read code from Rust 1.85 or later, which edition 2024
//! requires. Every hit needs a reason in `reviewed.txt` or the run fails, and so does a
//! reason that no longer matches a hit.
//!
//!   cargo run -q -p near-scan -- [--md ../security/near-scan.md]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use quote::ToTokens;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{BinOp, Expr, FnArg, ImplItem, Item, ReturnType, Stmt, Type};

const CONTRACTS: [&str; 4] = ["pool", "desk", "board", "token"];
/// Builder calls on a promise chain: not the method the chain calls.
const BUILDERS: [&str; 4] = ["with_static_gas", "with_attached_deposit", "with_unused_gas_weight", "clone"];
const COLLECTIONS: [&str; 11] = ["LookupMap", "LookupSet", "IterableMap", "IterableSet", "UnorderedMap", "UnorderedSet", "Vector", "TreeMap", "LazyOption", "TreeSet", "FungibleToken"];
const SETS: [&str; 4] = ["LookupSet", "IterableSet", "UnorderedSet", "TreeSet"];
const WRITES: [&str; 13] = ["insert", "remove", "push", "pop", "clear", "set", "replace", "get_mut", "entry", "extend", "retain", "swap_remove", "take"];
const WIDE_INTS: [&str; 4] = ["u64", "u128", "i64", "i128"];
const PANICS: [&str; 8] = [".unwrap()", ".expect(", "panic!", "require!", "panic_str", "assert!", "assert_eq!", "unreachable!"];

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Sev {
    High,
    Medium,
    Low,
    Info,
}

impl Sev {
    fn name(self) -> &'static str {
        match self {
            Sev::High => "High",
            Sev::Medium => "Medium",
            Sev::Low => "Low",
            Sev::Info => "Info",
        }
    }
}

struct Detector {
    id: &'static str,
    sev: Sev,
    checks: &'static str,
}

const DETECTORS: &[Detector] = &[
    Detector { id: "non-private-callback", sev: Sev::High, checks: "Every callback is `#[private]`, so no one else can call it with a made-up promise result" },
    Detector { id: "reentrancy", sev: Sev::High, checks: "Each cross-contract call whose callback writes state: what the call relies on is settled before it, so a receipt landing in between cannot exploit it" },
    Detector { id: "owner-check", sev: Sev::High, checks: "Public methods that change state with no caller check: each one's open access is intended" },
    Detector { id: "yocto-attach", sev: Sev::High, checks: "Caller-gated state changes require exactly 1 yoctoNEAR (a full-access key, not a function-call key)" },
    Detector { id: "incorrect-argument-or-return-types", sev: Sev::High, checks: "JSON arguments, return values and JSON structs avoid u64/u128/i64/i128 (JavaScript loses precision above 2^53)" },
    Detector { id: "unsaved-changes", sev: Sev::High, checks: "No legacy `near_sdk::collections` value is changed without writing it back (`near_sdk::store` writes back on its own)" },
    Detector { id: "storage-collision", sev: Sev::High, checks: "Every persistent collection has its own storage prefix" },
    Detector { id: "required-initialization-macro", sev: Sev::High, checks: "The contract state cannot be defaulted (`PanicOnDefault`) and has an `#[init]` method" },
    Detector { id: "unhandled-promise", sev: Sev::Medium, checks: "Cross-contract calls whose result no callback reads" },
    Detector { id: "prepaid-gas", sev: Sev::Medium, checks: "Every cross-contract call and callback carries explicit static gas" },
    Detector { id: "lock-callback", sev: Sev::Medium, checks: "Callbacks that can panic: a panic there cannot undo what changed before the call" },
    Detector { id: "nep141-receiver", sev: Sev::Medium, checks: "`ft_on_transfer` checks which token contract is calling" },
    Detector { id: "gas-griefing", sev: Sev::Medium, checks: "Loops in state-changing methods are bounded" },
    Detector { id: "insecure-random", sev: Sev::Medium, checks: "No randomness from block data (`random_seed`)" },
    Detector { id: "storage-measure-unflushed", sev: Sev::Medium, checks: "Storage is charged only after the buffered `near_sdk::store` writes are flushed (before that the new entries do not count, so nothing is charged)" },
    Detector { id: "cover-storage-cost", sev: Sev::Low, checks: "Methods that add to storage charge the caller for it" },
    Detector { id: "unused-ret", sev: Sev::Low, checks: "The result of inserting into or removing from a set is used (a set insert that returns false is a replay)" },
    Detector { id: "payable-unused", sev: Sev::Low, checks: "`#[payable]` methods use what is attached (NEAR attached to a method that ignores it stays in the contract)" },
    Detector { id: "unsafe-math", sev: Sev::Low, checks: "Release builds trap on integer overflow (`overflow-checks = true`)" },
    Detector { id: "lossy-cast", sev: Sev::Low, checks: "Narrowing casts (`as u8`, `as u16`, `as u32`) cannot truncate a value that matters" },
    Detector { id: "float-math", sev: Sev::Low, checks: "No floating point" },
    Detector { id: "non-callback-private", sev: Sev::Info, checks: "`#[private]` is only on callbacks" },
];

struct Method {
    at: String,
    name: String,
    attrs: BTreeSet<String>,
    mutates: bool,
    exposed: bool,
    params: Vec<(BTreeSet<String>, Type)>,
    ret: Option<Type>,
    block: syn::Block,
    flat: String,
}

#[derive(PartialEq)]
enum Root {
    SelfExt,
    Ext,
    PromiseNew,
}

struct Chain {
    root: Root,
    /// Method names from the outermost call inwards.
    names: Vec<String>,
    at: String,
}

#[derive(Default)]
struct Contract {
    methods: Vec<Method>,
    /// State struct field name to the collection type's name.
    fields: BTreeMap<String, String>,
    state_ok: Option<(String, bool)>,
    json_fields: Vec<(String, String, String)>,
    prefixes: Vec<(String, String)>,
    floats: Vec<String>,
    /// Free functions' bodies, so a method's checks include the helpers it calls.
    free_fns: BTreeMap<String, String>,
    casts: BTreeMap<String, Vec<String>>,
    legacy: Vec<(String, String)>,
}

struct Hit {
    det: &'static str,
    contract: &'static str,
    item: String,
    at: String,
    note: String,
}

/// Tokens with the whitespace taken out, for plain substring checks.
fn flat<T: ToTokens>(t: &T) -> String {
    t.to_token_stream().to_string().split_whitespace().collect()
}

fn attr_names(attrs: &[syn::Attribute]) -> BTreeSet<String> {
    attrs.iter().filter_map(|a| a.path().segments.last().map(|s| s.ident.to_string())).collect()
}

fn is_test(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|a| a.path().is_ident("cfg") && flat(a).contains("test"))
}

fn item_attrs(item: &Item) -> &[syn::Attribute] {
    match item {
        Item::Mod(x) => &x.attrs,
        Item::Fn(x) => &x.attrs,
        Item::Impl(x) => &x.attrs,
        Item::Struct(x) => &x.attrs,
        Item::Enum(x) => &x.attrs,
        Item::Const(x) => &x.attrs,
        Item::Use(x) => &x.attrs,
        _ => &[],
    }
}

fn type_idents(t: &Type) -> BTreeSet<String> {
    struct V(BTreeSet<String>);
    impl<'a> Visit<'a> for V {
        fn visit_path_segment(&mut self, s: &'a syn::PathSegment) {
            self.0.insert(s.ident.to_string());
            visit::visit_path_segment(self, s);
        }
    }
    let mut v = V(BTreeSet::new());
    v.visit_type(t);
    v.0
}

fn wide(t: &Type) -> bool {
    type_idents(t).iter().any(|i| WIDE_INTS.contains(&i.as_str()))
}

fn root_kind(e: &Expr) -> Option<Root> {
    let Expr::Call(c) = e else { return None };
    let Expr::Path(p) = &*c.func else { return None };
    let segs: Vec<String> = p.path.segments.iter().map(|s| s.ident.to_string()).collect();
    match segs.as_slice() {
        [.., m, last] if last == "ext" && (m == "ext_self" || m == "Self") => Some(Root::SelfExt),
        [.., _, last] if last == "ext" => Some(Root::Ext),
        [.., a, b] if a == "Promise" && b == "new" => Some(Root::PromiseNew),
        _ => None,
    }
}

/// Promise chains in a body, each recorded once from its outermost call.
fn chains(block: &syn::Block, file: &str) -> Vec<Chain> {
    struct V<'f> {
        file: &'f str,
        out: Vec<Chain>,
        seen: BTreeSet<(usize, usize)>,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_expr_method_call(&mut self, m: &'a syn::ExprMethodCall) {
            let mut names = vec![m.method.to_string()];
            let mut e: &Expr = &m.receiver;
            loop {
                match e {
                    Expr::MethodCall(x) => {
                        names.push(x.method.to_string());
                        e = &x.receiver;
                    }
                    Expr::Paren(p) => e = &p.expr,
                    _ => break,
                }
            }
            if let Some(root) = root_kind(e) {
                let pos = e.span().start();
                if self.seen.insert((pos.line, pos.column)) {
                    self.out.push(Chain { root, names, at: format!("{}:{}", self.file, pos.line) });
                }
            }
            visit::visit_expr_method_call(self, m);
        }
    }
    let mut v = V { file, out: vec![], seen: BTreeSet::new() };
    v.visit_block(block);
    v.out
}

fn callee(c: &Chain) -> Option<&str> {
    c.names.iter().map(String::as_str).find(|n| !BUILDERS.contains(n))
}

/// Whether a body writes contract state, directly or through a `&mut self` helper.
fn writes_state(block: &syn::Block, helpers: &BTreeSet<String>) -> bool {
    struct V<'h> {
        hit: bool,
        helpers: &'h BTreeSet<String>,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_expr_assign(&mut self, a: &'a syn::ExprAssign) {
            if flat(&a.left).starts_with("self.") {
                self.hit = true;
            }
            visit::visit_expr_assign(self, a);
        }
        fn visit_expr_binary(&mut self, b: &'a syn::ExprBinary) {
            let assign = matches!(
                b.op,
                BinOp::AddAssign(_) | BinOp::SubAssign(_) | BinOp::MulAssign(_) | BinOp::DivAssign(_) | BinOp::RemAssign(_) | BinOp::BitOrAssign(_) | BinOp::BitAndAssign(_)
            );
            if assign && flat(&b.left).starts_with("self.") {
                self.hit = true;
            }
            visit::visit_expr_binary(self, b);
        }
        fn visit_expr_method_call(&mut self, m: &'a syn::ExprMethodCall) {
            let recv = flat(&m.receiver);
            let name = m.method.to_string();
            if (recv.starts_with("self.") && WRITES.contains(&name.as_str())) || (recv == "self" && self.helpers.contains(&name)) {
                self.hit = true;
            }
            visit::visit_expr_method_call(self, m);
        }
    }
    let mut v = V { hit: false, helpers };
    v.visit_block(block);
    v.hit
}

/// Inserts into a contract collection (`self.x.insert(..)`, `push`, `entry`).
fn adds_storage(block: &syn::Block) -> bool {
    struct V(bool);
    impl<'a> Visit<'a> for V {
        fn visit_expr_method_call(&mut self, m: &'a syn::ExprMethodCall) {
            if flat(&m.receiver).starts_with("self.") && ["insert", "push", "entry"].contains(&m.method.to_string().as_str()) {
                self.0 = true;
            }
            visit::visit_expr_method_call(self, m);
        }
    }
    let mut v = V(false);
    v.visit_block(block);
    v.0
}

fn loops(block: &syn::Block) -> Vec<String> {
    struct V(Vec<String>);
    impl<'a> Visit<'a> for V {
        fn visit_expr_for_loop(&mut self, f: &'a syn::ExprForLoop) {
            self.0.push(format!("for over `{}`", flat(&f.expr)));
            visit::visit_expr_for_loop(self, f);
        }
        fn visit_expr_while(&mut self, w: &'a syn::ExprWhile) {
            self.0.push(format!("while `{}`", flat(&w.cond)));
            visit::visit_expr_while(self, w);
        }
        fn visit_expr_loop(&mut self, l: &'a syn::ExprLoop) {
            self.0.push("loop".into());
            visit::visit_expr_loop(self, l);
        }
    }
    let mut v = V(vec![]);
    v.visit_block(block);
    v.0
}

/// Set inserts and removes used as statements, their result dropped.
fn dropped_set_results(block: &syn::Block, fields: &BTreeMap<String, String>) -> Vec<String> {
    struct V<'f>(Vec<String>, &'f BTreeMap<String, String>);
    impl<'a> Visit<'a> for V<'_> {
        fn visit_stmt(&mut self, s: &'a Stmt) {
            if let Stmt::Expr(Expr::MethodCall(m), Some(_)) = s {
                let recv = flat(&m.receiver);
                let name = m.method.to_string();
                if let Some(field) = recv.strip_prefix("self.")
                    && (name == "insert" || name == "remove")
                    && self.1.get(field).is_some_and(|t| SETS.contains(&t.as_str()))
                {
                    self.0.push(format!("self.{field}.{name}"));
                }
            }
            visit::visit_stmt(self, s);
        }
    }
    let mut v = V(vec![], fields);
    v.visit_block(block);
    v.0
}

/// Whole-file facts outside test code: floats, narrowing casts, collection prefixes, legacy collections.
struct FileScan<'c> {
    file: String,
    func: Vec<String>,
    c: &'c mut Contract,
}

impl<'a> Visit<'a> for FileScan<'_> {
    fn visit_item_mod(&mut self, m: &'a syn::ItemMod) {
        if !is_test(&m.attrs) {
            visit::visit_item_mod(self, m);
        }
    }
    fn visit_item_fn(&mut self, f: &'a syn::ItemFn) {
        if is_test(&f.attrs) {
            return;
        }
        self.func.push(f.sig.ident.to_string());
        visit::visit_item_fn(self, f);
        self.func.pop();
    }
    fn visit_impl_item_fn(&mut self, f: &'a syn::ImplItemFn) {
        if is_test(&f.attrs) {
            return;
        }
        self.func.push(f.sig.ident.to_string());
        visit::visit_impl_item_fn(self, f);
        self.func.pop();
    }
    fn visit_lit_float(&mut self, l: &'a syn::LitFloat) {
        self.c.floats.push(format!("{}:{}", self.file, l.span().start().line));
    }
    fn visit_type_path(&mut self, t: &'a syn::TypePath) {
        if t.path.is_ident("f32") || t.path.is_ident("f64") {
            self.c.floats.push(format!("{}:{}", self.file, t.span().start().line));
        }
        visit::visit_type_path(self, t);
    }
    fn visit_expr_cast(&mut self, c: &'a syn::ExprCast) {
        let target = flat(&c.ty);
        if ["u8", "u16", "u32", "i8", "i16", "i32"].contains(&target.as_str()) {
            let func = self.func.last().cloned().unwrap_or_else(|| "(top level)".into());
            self.c.casts.entry(func).or_default().push(format!("{}:{} `{}`", self.file, c.span().start().line, flat(c)));
        }
        visit::visit_expr_cast(self, c);
    }
    fn visit_expr_call(&mut self, call: &'a syn::ExprCall) {
        if let Expr::Path(p) = &*call.func {
            let segs: Vec<String> = p.path.segments.iter().map(|s| s.ident.to_string()).collect();
            if let [.., ty, new] = segs.as_slice()
                && new == "new"
                && COLLECTIONS.contains(&ty.as_str())
                && let Some(arg) = call.args.first()
            {
                // a variant with fields (`Key::Notes { token }`) is one prefix per value: keep the variant
                let key = flat(arg);
                let key = key.split('{').next().unwrap_or(&key).trim_end_matches(".into_storage_key()").to_string();
                self.c.prefixes.push((key, format!("{}:{}", self.file, call.span().start().line)));
            }
        }
        visit::visit_expr_call(self, call);
    }
    fn visit_item_use(&mut self, u: &'a syn::ItemUse) {
        let f = flat(u);
        if f.contains("near_sdk") && f.contains("collections::") {
            self.c.legacy.push((f, format!("{}:{}", self.file, u.span().start().line)));
        }
    }
}

fn load(root: &Path, name: &'static str) -> Contract {
    let src = root.join(name).join("src");
    let mut files: Vec<PathBuf> = fs::read_dir(&src)
        .unwrap_or_else(|e| panic!("{}: {e}", src.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "rs") && p.file_name().is_some_and(|n| n != "tests.rs"))
        .collect();
    files.sort();
    let mut c = Contract::default();
    for path in files {
        let rel = format!("{name}/src/{}", path.file_name().unwrap().to_string_lossy());
        let text = fs::read_to_string(&path).unwrap();
        let file = syn::parse_file(&text).unwrap_or_else(|e| panic!("{rel}: {e}"));
        FileScan { file: rel.clone(), func: vec![], c: &mut c }.visit_file(&file);
        for item in &file.items {
            if is_test(item_attrs(item)) {
                continue;
            }
            match item {
                Item::Impl(imp) => {
                    let names = attr_names(&imp.attrs);
                    let exposed_block = names.contains("near") || names.contains("near_bindgen");
                    for ii in &imp.items {
                        let ImplItem::Fn(f) = ii else { continue };
                        if is_test(&f.attrs) {
                            continue;
                        }
                        let mut mutates = false;
                        let mut params = vec![];
                        for a in &f.sig.inputs {
                            match a {
                                FnArg::Receiver(r) => mutates = r.mutability.is_some(),
                                FnArg::Typed(pt) => params.push((attr_names(&pt.attrs), (*pt.ty).clone())),
                            }
                        }
                        c.methods.push(Method {
                            at: format!("{rel}:{}", f.sig.ident.span().start().line),
                            name: f.sig.ident.to_string(),
                            attrs: attr_names(&f.attrs),
                            mutates,
                            exposed: exposed_block && (imp.trait_.is_some() || matches!(f.vis, syn::Visibility::Public(_))),
                            params,
                            ret: match &f.sig.output {
                                ReturnType::Type(_, t) => Some((**t).clone()),
                                ReturnType::Default => None,
                            },
                            block: f.block.clone(),
                            flat: flat(&f.block),
                        });
                    }
                }
                Item::Struct(st) => {
                    let attrs = st.attrs.iter().map(flat).collect::<String>();
                    if attrs.contains("contract_state") {
                        for f in &st.fields {
                            if let (Some(id), Some(last)) = (&f.ident, type_idents(&f.ty).iter().find(|i| COLLECTIONS.contains(&i.as_str()))) {
                                c.fields.insert(id.to_string(), last.clone());
                            }
                        }
                        c.state_ok = Some((format!("{rel}:{}", st.ident.span().start().line), attrs.contains("PanicOnDefault")));
                    }
                    if attrs.contains("json") || attrs.contains("Serialize") || attrs.contains("Deserialize") {
                        for f in &st.fields {
                            if wide(&f.ty) {
                                let field = f.ident.as_ref().map(|i| i.to_string()).unwrap_or_default();
                                c.json_fields.push((format!("{}.{field}", st.ident), format!("{rel}:{}", f.ty.span().start().line), flat(&f.ty)));
                            }
                        }
                    }
                }
                Item::Enum(en) => {
                    let attrs = en.attrs.iter().map(flat).collect::<String>();
                    if attrs.contains("json") || attrs.contains("Serialize") || attrs.contains("Deserialize") {
                        for v in &en.variants {
                            for f in &v.fields {
                                if wide(&f.ty) {
                                    c.json_fields.push((format!("{}::{}", en.ident, v.ident), format!("{rel}:{}", f.ty.span().start().line), flat(&f.ty)));
                                }
                            }
                        }
                    }
                }
                Item::Fn(f) => {
                    c.free_fns.insert(f.sig.ident.to_string(), flat(&f.block));
                }
                _ => {}
            }
        }
    }
    c
}

/// A body with the bodies of the helpers it calls (methods and free functions), followed transitively.
fn deep_flat(start: &str, bodies: &BTreeMap<String, String>) -> String {
    let mut out = String::new();
    let mut todo = vec![start.to_string()];
    let mut seen = BTreeSet::new();
    while let Some(name) = todo.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        let Some(body) = bodies.get(&name) else { continue };
        out.push_str(body);
        for callee in bodies.keys() {
            let called = body.contains(&format!("self.{callee}(")) || body.contains(&format!("Self::{callee}(")) || body.match_indices(&format!("{callee}(")).any(|(i, _)| i == 0 || !body[..i].ends_with(|ch: char| ch.is_alphanumeric() || ch == '_' || ch == '.' || ch == ':'));
            if called {
                todo.push(callee.clone());
            }
        }
    }
    out
}

fn scan(contract: &'static str, c: &Contract, overflow_checks: bool) -> Vec<Hit> {
    let mut hits = vec![];
    let mut hit = |det: &'static str, item: String, at: String, note: String| hits.push(Hit { det, contract, item, at, note });
    let helpers: BTreeSet<String> = c.methods.iter().filter(|m| m.mutates).map(|m| m.name.clone()).collect();
    let all_chains: Vec<(&Method, Vec<Chain>)> = c.methods.iter().map(|m| (m, chains(&m.block, m.at.split(':').next().unwrap()))).collect();
    let callbacks: BTreeSet<String> = all_chains.iter().flat_map(|(_, cs)| cs.iter().filter(|ch| ch.root == Root::SelfExt).filter_map(|ch| callee(ch).map(String::from))).collect();
    let mut bodies: BTreeMap<String, String> = c.free_fns.clone();
    for m in &c.methods {
        bodies.insert(m.name.clone(), m.flat.clone());
    }
    let deep = |m: &Method| deep_flat(&m.name, &bodies);
    let is_callback = |m: &Method| {
        callbacks.contains(&m.name) || m.params.iter().any(|(a, _)| a.iter().any(|x| x.starts_with("callback"))) || m.flat.contains("promise_result")
    };

    for m in c.methods.iter().filter(|m| m.exposed) {
        let private = m.attrs.contains("private");
        let init = m.attrs.contains("init");
        let callback = is_callback(m);
        let d = deep(m);
        // who called, read in the method itself or in an `assert_*` helper it calls (a helper
        // that reads the caller may only be charging it)
        let guard = |n: &String| n.starts_with("assert_") && m.flat.contains(&format!("self.{n}(")) && bodies[n].contains("predecessor_account_id()");
        let caller_checked = m.flat.contains("predecessor_account_id()") || m.flat.contains("signer_account_id()") || bodies.keys().any(guard);
        // a privileged caller: the owner, not just "whose account this is"
        let owner_gated = d.contains("assert_owner()") || d.contains("==self.owner") || d.contains("self.owner==") || d.contains("==self.config.owner");
        if callback && !private {
            hit("non-private-callback", m.name.clone(), m.at.clone(), "callback without #[private]".into());
        }
        if private && !callback {
            hit("non-callback-private", m.name.clone(), m.at.clone(), "#[private] but no callback reaches it".into());
        }
        if m.mutates && !private && !init && owner_gated && !d.contains("assert_one_yocto()") {
            hit("yocto-attach", m.name.clone(), m.at.clone(), "owner-only state change without assert_one_yocto".into());
        }
        if m.mutates && !private && !init && !caller_checked {
            hit("owner-check", m.name.clone(), m.at.clone(), "anyone may call it".into());
        }
        let json_params: Vec<String> = m.params.iter().filter(|(a, t)| !a.iter().any(|x| x.starts_with("callback") || x == "serializer") && wide(t)).map(|(_, t)| flat(t)).collect();
        let json_ret = m.ret.as_ref().filter(|t| wide(t) && !m.attrs.contains("result_serializer")).map(flat);
        if !json_params.is_empty() || json_ret.is_some() {
            let mut note = String::new();
            if !json_params.is_empty() {
                write!(note, "argument {}", json_params.join(", ")).unwrap();
            }
            if let Some(r) = json_ret {
                write!(note, "{}returns {r}", if note.is_empty() { "" } else { "; " }).unwrap();
            }
            hit("incorrect-argument-or-return-types", m.name.clone(), m.at.clone(), note);
        }
        if m.attrs.contains("payable") && !d.contains("attached_deposit") && !d.contains("assert_one_yocto") {
            hit("payable-unused", m.name.clone(), m.at.clone(), "#[payable] without reading the deposit".into());
        }
        if m.name == "ft_on_transfer" && !d.contains("predecessor_account_id()") {
            hit("nep141-receiver", m.name.clone(), m.at.clone(), "does not check the calling token".into());
        }
        if m.mutates && !private && !init && adds_storage(&m.block) && !["storage_usage", "attached_deposit", "storage_balance", "assert_owner"].iter().any(|k| d.contains(k)) {
            hit("cover-storage-cost", m.name.clone(), m.at.clone(), "adds to storage without charging for it here".into());
        }
        if m.mutates {
            for l in loops(&m.block) {
                hit("gas-griefing", format!("{}: {l}", m.name), m.at.clone(), "loop in a state-changing method".into());
            }
        }
        if callback {
            let panics: Vec<&str> = PANICS.iter().copied().filter(|p| d.contains(p)).collect();
            if !panics.is_empty() {
                hit("lock-callback", m.name.clone(), m.at.clone(), format!("can panic: {}", panics.join(" ")));
            }
        }
    }

    for (m, cs) in &all_chains {
        let external: Vec<&Chain> = cs.iter().filter(|ch| ch.root != Root::SelfExt).collect();
        for ch in cs.iter().filter(|ch| ch.root != Root::PromiseNew) {
            if !ch.names.iter().any(|n| n == "with_static_gas") {
                hit("prepaid-gas", format!("{} ({})", m.name, callee(ch).unwrap_or("?")), ch.at.clone(), "no static gas on this call".into());
            }
        }
        // a helper that returns its promise leaves the callback to its caller
        let returns_promise = m.ret.as_ref().is_some_and(|t| type_idents(t).iter().any(|i| i.starts_with("Promise")));
        if !external.is_empty() && !m.flat.contains(".then(") && !returns_promise {
            let calls: Vec<&str> = external.iter().filter_map(|ch| callee(ch)).collect();
            hit("unhandled-promise", m.name.clone(), m.at.clone(), format!("result not read: {}", calls.join(", ")));
        }
        if !external.is_empty() {
            for cb in cs.iter().filter(|ch| ch.root == Root::SelfExt).filter_map(callee) {
                if let Some(target) = c.methods.iter().find(|x| x.name == cb)
                    && target.mutates
                    && writes_state(&target.block, &helpers)
                {
                    hit("reentrancy", format!("{} -> {cb}", m.name), m.at.clone(), "the callback writes state after the call".into());
                }
            }
        }
        if m.mutates {
            for d in dropped_set_results(&m.block, &c.fields) {
                hit("unused-ret", format!("{}: {d}", m.name), m.at.clone(), "result dropped".into());
            }
        }
        if m.flat.contains("random_seed") {
            hit("insecure-random", m.name.clone(), m.at.clone(), "reads env::random_seed".into());
        }
    }

    // a function that turns storage use into a charge must flush the store collections first
    let charges = |body: &str| body.contains("storage_usage()") && body.contains("storage_byte_cost()") && !body.contains(".flush()");
    for m in c.methods.iter().filter(|m| charges(&m.flat)) {
        hit("storage-measure-unflushed", m.name.clone(), m.at.clone(), "measures storage without flushing the collections".into());
    }
    for name in c.free_fns.iter().filter(|(_, b)| charges(b)).map(|(n, _)| n) {
        hit("storage-measure-unflushed", name.clone(), contract.into(), "measures storage without flushing the collections".into());
    }

    let mut seen: BTreeMap<&str, &str> = BTreeMap::new();
    for (key, at) in &c.prefixes {
        if let Some(first) = seen.insert(key, at) {
            hit("storage-collision", key.clone(), at.clone(), format!("same prefix as {first}"));
        }
    }
    match &c.state_ok {
        Some((_, true)) if c.methods.iter().any(|m| m.attrs.contains("init")) => {}
        Some((at, _)) => hit("required-initialization-macro", "state".into(), at.clone(), "no PanicOnDefault or no #[init]".into()),
        None => hit("required-initialization-macro", "state".into(), contract.into(), "no #[near(contract_state)] struct found".into()),
    }
    for (use_, at) in &c.legacy {
        let ty = use_.rsplit("collections::").next().unwrap_or(use_).trim_end_matches(';').to_string();
        hit("unsaved-changes", ty, at.clone(), "legacy collection: changes need an explicit write back".into());
    }
    for (item, at, ty) in &c.json_fields {
        hit("incorrect-argument-or-return-types", item.clone(), at.clone(), format!("JSON field of type {ty}"));
    }
    for at in &c.floats {
        hit("float-math", "float".into(), at.clone(), "floating point".into());
    }
    for (func, sites) in &c.casts {
        hit("lossy-cast", func.clone(), sites[0].split(' ').next().unwrap_or_default().into(), sites.join("; "));
    }
    if !overflow_checks {
        hit("unsafe-math", "profile.release".into(), "Cargo.toml".into(), "overflow-checks is not on".into());
    }
    hits
}

/// `detector | contract | item | reason` per line; `#` starts a comment.
fn reviewed(path: &Path) -> BTreeMap<(String, String, String), String> {
    let text = fs::read_to_string(path).unwrap_or_default();
    let mut out = BTreeMap::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.splitn(4, " | ").collect();
        let [det, contract, item, why] = parts.as_slice() else { panic!("reviewed.txt:{}: expected `detector | contract | item | reason`", n + 1) };
        out.insert((det.to_string(), contract.to_string(), item.to_string()), why.to_string());
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let md_out = args.iter().position(|a| a == "--md").and_then(|i| args.get(i + 1)).map(PathBuf::from);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let cargo_toml = fs::read_to_string(root.join("Cargo.toml")).unwrap();
    let overflow_checks = cargo_toml.split("[profile.release]").nth(1).is_some_and(|s| s.split("\n[").next().unwrap_or("").contains("overflow-checks = true"));
    let reviewed_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("reviewed.txt");
    let mut reasons = reviewed(&reviewed_path);

    let mut hits = vec![];
    let mut coverage = String::new();
    for name in CONTRACTS {
        let c = load(&root, name);
        let exposed = c.methods.iter().filter(|m| m.exposed).count();
        let calls: usize = c.methods.iter().map(|m| chains(&m.block, "").len()).sum();
        writeln!(coverage, "| `{name}` | {exposed} | {calls} | {} |", c.prefixes.len()).unwrap();
        hits.extend(scan(name, &c, overflow_checks));
    }

    let mut open = 0;
    let mut stale = 0;
    let mut by_det: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    let mut rows = String::new();
    for h in &hits {
        let key = (h.det.to_string(), h.contract.to_string(), h.item.clone());
        let entry = by_det.entry(h.det).or_default();
        match reasons.remove(&key) {
            Some(why) => {
                entry.0 += 1;
                writeln!(rows, "| {} | `{}` | `{}` ({}) | {} |", h.det, h.contract, h.item, h.at, why).unwrap();
            }
            None => {
                entry.1 += 1;
                open += 1;
                println!("UNREVIEWED  {} | {} | {} | {}  ({})", h.det, h.contract, h.item, h.note, h.at);
            }
        }
    }
    for (det, contract, item) in reasons.keys() {
        stale += 1;
        println!("STALE       {det} | {contract} | {item}  (reviewed.txt names a hit that no longer exists)");
    }

    let mut table = String::new();
    for d in DETECTORS {
        let (ok, open) = by_det.get(d.id).copied().unwrap_or_default();
        let result = match (ok, open) {
            (0, 0) => "No hits".to_string(),
            (n, 0) => format!("{n} reviewed"),
            (_, n) => format!("{n} open"),
        };
        println!("{:<8} {:<36} {result}", d.sev.name(), d.id);
        writeln!(table, "| `{}` | {} | {} | {result} |", d.id, d.sev.name(), d.checks).unwrap();
    }
    println!("\n{} hits: {} reviewed, {open} open; {stale} stale reasons", hits.len(), hits.len() - open);

    if let Some(path) = md_out {
        let md = format!(
            "# near-scan report\n\nGenerated by `contracts/tools/near-scan` (`pnpm security`). Do not edit by hand.\n\n\
             | Contract | Public methods | Cross-contract calls and callbacks | Storage prefixes |\n| --- | --- | --- | --- |\n{coverage}\n\
             ## Detectors\n\n| Detector | Severity | What it checks | Result |\n| --- | --- | --- | --- |\n{table}\n\
             ## Reviewed hits\n\nEach hit and the reason it is safe, from `contracts/tools/near-scan/reviewed.txt`.\n\n\
             | Detector | Contract | Where | Why it is safe |\n| --- | --- | --- | --- |\n{rows}"
        );
        fs::write(&path, md).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    }
    if open + stale > 0 {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_contract_with_the_classic_mistakes_trips_each_detector() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        let c = load(&root, "broken");
        let found: BTreeSet<&str> = scan("broken", &c, false).iter().map(|h| h.det).collect();
        for det in [
            "non-private-callback",
            "reentrancy",
            "yocto-attach",
            "incorrect-argument-or-return-types",
            "required-initialization-macro",
            "storage-collision",
            "unhandled-promise",
            "prepaid-gas",
            "nep141-receiver",
            "insecure-random",
            "unused-ret",
            "unsafe-math",
            "float-math",
            "storage-measure-unflushed",
        ] {
            assert!(found.contains(det), "{det} did not fire on the broken contract");
        }
    }
}
