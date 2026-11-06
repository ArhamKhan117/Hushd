"use client";

/**
 * The owner's side of agent policy wallets (OutLayer custody on NEAR): Hushd's own
 * agents' wallets, read from chain; a signed-in owner's wallets, with freeze and unfreeze;
 * and a new wallet for the owner's agent, with its policy stored from the owner's account.
 * The agent's key is held in memory only and goes nowhere but OutLayer.
 */
import { formatUnits, parseUnits } from "@hushd/protocol";
import {
  accountBalance,
  accountUrl,
  CUSTODY,
  CustodyWallet,
  custodyView,
  deskView,
  freezeCall,
  hushdPolicyRules,
  isAddress,
  storePolicyCall,
  txUrl,
  unfreezeCall,
  view,
  type CallSpec,
  type PolicyRules,
} from "@hushd/sdk";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Segmented, Steps, type Step, type StepState } from "@/components/app/desk";
import { ErrorLine, Field } from "@/components/app/forms";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { CodeBlock, CopyButton } from "@/components/ui/CodeBlock";
import { BusyLabel, Spinner } from "@/components/ui/Spinner";
import { passkeySupported } from "@/lib/hushd/keys";
import { NETWORK } from "@/lib/hushd/config";
import { StateDot, when } from "@/lib/hushd/deal";
import { parseAmount, TOKENS } from "@/lib/hushd/format";
import { useHushd, type ChainCall } from "@/lib/hushd/session";

const CUST = CUSTODY[NETWORK.id];
const MILLI_NEAR = 10n ** 21n;

/** One row of `get_wallet_policies_by_owner` on OutLayer's contract. */
interface OwnedWallet {
  wallet_pubkey: string;
  owner: string;
  frozen: boolean;
  /** nanoseconds */
  updated_at: number;
}

export interface WalletLabel {
  account: string;
  label: string;
}

const accountOf = (w: OwnedWallet) => w.wallet_pubkey.replace(/^ed25519:/, "");
const shortAccount = (a: string) => (a.length > 20 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
const toChainCall = (c: CallSpec): ChainCall => ({ contract: c.receiver, method: c.method, args: c.args, gas: c.gas.toString(), deposit: c.deposit.toString() });

function nearAmount(input: string): bigint | null {
  try {
    const v = parseUnits(input.replace(/,/g, "").trim(), 24);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}
const nearText = (yocto: bigint) => Number(formatUnits(yocto, 24)).toLocaleString("en-US", { maximumFractionDigits: 4 });

/** Ask `check` a few times while the chain catches up; true once it holds. */
async function until(check: () => Promise<boolean>, tries = 8, gapMs = 1500): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await check().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

const readWallets = async (owner: string) =>
  [...(await view<OwnedWallet[]>(NETWORK, CUST.contract, "get_wallet_policies_by_owner", { owner }))].sort((a, b) => b.updated_at - a.updated_at);

function useOwnerWallets(owner: string) {
  const [wallets, setWallets] = useState<OwnedWallet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setWallets(await readWallets(owner));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [owner]);
  useEffect(() => {
    let live = true;
    readWallets(owner).then(
      (w) => {
        if (!live) return;
        setWallets(w);
        setError(null);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [owner]);
  return { wallets, error, load };
}

function NearBlocksLink({ account }: { account: string }) {
  return (
    <a
      href={accountUrl(NETWORK, account)}
      target="_blank"
      rel="noreferrer"
      aria-label={`${shortAccount(account)} on NearBlocks`}
      className="hd-tap inline-flex items-center gap-1 text-mute underline decoration-line-strong underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground"
    >
      NearBlocks
      <ArrowUpRight />
    </a>
  );
}

function TxLink({ hash }: { hash: string }) {
  if (!hash) return null;
  return (
    <a href={txUrl(NETWORK, hash)} target="_blank" rel="noreferrer" className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
      View on NearBlocks
    </a>
  );
}

function WalletRow({ w, label, extra, action }: { w: OwnedWallet; label?: string; extra?: string; action?: ReactNode }) {
  const account = accountOf(w);
  return (
    <li
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 px-4 py-3.5 sm:gap-x-6 sm:px-5 ${action ? "sm:grid-cols-[minmax(0,1fr)_auto_auto]" : ""}`}
      data-wallet={account}
    >
      <div className="col-start-1 row-start-1 min-w-0">
        {label && (
          <p className="text-[14.5px] text-foreground">
            {label}
            {extra && <span className="text-mute"> · {extra}</span>}
          </p>
        )}
        <p className={`flex items-center gap-1 ${label ? "text-[12.5px] text-mute" : "text-[14.5px] text-foreground"}`}>
          <span className="tnum" title={account}>
            {shortAccount(account)}
          </span>
          <CopyButton text={account} label={`Copy account ${account}`} className="-my-1.5" />
        </p>
      </div>
      <div className="col-span-2 row-start-2 flex flex-wrap items-center gap-x-4 gap-y-2 sm:gap-x-5 text-[13px] sm:col-span-1 sm:col-start-2 sm:row-start-1">
        <span className="flex items-center gap-2 text-soft sm:w-[4.25rem]">
          <StateDot tone={w.frozen ? "wait" : "ok"} />
          {w.frozen ? "Frozen" : "Active"}
        </span>
        <span className="tnum whitespace-nowrap text-mute sm:w-[9.5rem]">Changed {when(Math.floor(w.updated_at / 1e6))}</span>
        <NearBlocksLink account={account} />
      </div>
      {action && <div className="col-start-2 row-start-1 sm:col-start-3">{action}</div>}
    </li>
  );
}

function ListSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="grid gap-2 p-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="hd-skeleton h-12" />
      ))}
    </div>
  );
}

function CardHead({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-[12.5px] text-mute sm:px-5">
      <span className="min-w-0 truncate">{title}</span>
      {meta && <span className="shrink-0">{meta}</span>}
    </div>
  );
}

/** Hushd's own agents' wallets, for everyone. */
function HushdWallets({ owner, labels }: { owner: string; labels: WalletLabel[] }) {
  const { wallets, error } = useOwnerWallets(owner);
  const [makerNames, setMakerNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    deskView.makers(NETWORK).then(
      (m) => setMakerNames(new Map(m.map(([acc, x]) => [acc, x.name]))),
      () => undefined,
    );
  }, []);
  const order = useMemo(() => new Map(labels.map((l, i) => [l.account, i])), [labels]);
  const sorted = useMemo(
    () => (wallets ? [...wallets].sort((a, b) => (order.get(accountOf(a)) ?? 99) - (order.get(accountOf(b)) ?? 99) || b.updated_at - a.updated_at) : null),
    [wallets, order],
  );

  return (
    <div className="hd-card overflow-hidden" aria-label="Hushd's policy wallets" role="region">
      <CardHead title="Hushd's agents" meta={`Owner ${owner}`} />
      {error && <p className="px-4 py-3.5 text-[13.5px] text-danger sm:px-5">Could not read OutLayer&apos;s contract: {error}</p>}
      {!sorted && !error && <ListSkeleton rows={3} />}
      {sorted && sorted.length === 0 && <p className="px-4 py-3.5 text-[14px] text-mute sm:px-5">No policy wallets yet.</p>}
      {sorted && sorted.length > 0 && (
        <ul className="divide-y divide-line">
          {sorted.map((w) => {
            const account = accountOf(w);
            const label = labels.find((l) => l.account === account)?.label ?? "Test wallet";
            const name = makerNames.get(account);
            return <WalletRow key={w.wallet_pubkey} w={w} label={label} {...(name ? { extra: name } : {})} />;
          })}
        </ul>
      )}
    </div>
  );
}

/** Sign in for the owner's side: a wallet signs at once, a passkey account after unlock. */
function OwnerSignIn() {
  const s = useHushd();
  const [busy, setBusy] = useState<string | null>(null);
  const go = (k: string, f: () => Promise<void>) => async () => {
    setBusy(k);
    try {
      await f();
    } catch {
      /* the session shows the error */
    } finally {
      setBusy(null);
    }
  };

  if (s.status === "loading") {
    return (
      <div className="hd-card flex items-center gap-3 p-5 text-[14px] text-mute sm:p-6">
        <Spinner /> Checking for a wallet…
      </div>
    );
  }
  const locked = s.status === "connected" && s.kind === "passkey";
  return (
    <div className="hd-card grid gap-4 p-5 sm:p-6">
      <div>
        <h2 className="t-title">Create a policy wallet for your agent</h2>
        <p className="mt-1.5 max-w-[60ch] text-[14px] leading-relaxed text-mute">
          {locked
            ? `Use your passkey to sign as ${shortAccount(s.accountId ?? "")} on this device.`
            : "Sign in with a NEAR wallet or a passkey. Your account becomes the wallet's owner: it stores the policy and is the only account that can freeze it."}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {locked ? (
          <>
            <button type="button" className="btn btn-ink" onClick={go("unlock", s.unlock)} disabled={busy !== null} aria-busy={busy === "unlock"}>
              {busy === "unlock" ? <Spinner /> : null} Use passkey
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => void s.signOut()}>
              Sign out
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-ink" onClick={go("wallet", s.connectWallet)} disabled={busy !== null}>
              {busy === "wallet" ? <Spinner /> : null} Connect a NEAR wallet
            </button>
            {passkeySupported() && (
              <>
                <button type="button" className="btn btn-ghost" onClick={go("create", s.createPasskeyAccount)} disabled={busy !== null}>
                  {busy === "create" ? <Spinner /> : null} Create a passkey
                </button>
                <button type="button" className="btn btn-quiet" onClick={go("passkey", s.unlockWithPasskey)} disabled={busy !== null}>
                  I have a passkey
                </button>
              </>
            )}
          </>
        )}
      </div>
      {s.error && (
        <p className="text-[13.5px] text-danger" role="alert">
          {s.error}
        </p>
      )}
    </div>
  );
}

/** The signed-in owner's wallets, each with Freeze or Unfreeze. */
function YourWallets({ owner, wallets, error, reload, fresh }: { owner: string; wallets: OwnedWallet[] | null; error: string | null; reload: () => Promise<void>; fresh: string | null }) {
  const s = useHushd();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [last, setLast] = useState<{ hash: string; text: string } | null>(null);

  const toggle = async (w: OwnedWallet) => {
    setBusy(w.wallet_pubkey);
    setActionError(null);
    setLast(null);
    try {
      const freeze = !w.frozen;
      const { txHash } = await s.call(toChainCall((freeze ? freezeCall : unfreezeCall)(CUST.contract, w.wallet_pubkey)));
      const ok = await until(async () => (await custodyView.policy(NETWORK, w.wallet_pubkey))?.frozen === freeze);
      await reload();
      if (!ok) throw new Error(`The chain does not show the wallet ${freeze ? "frozen" : "unfrozen"} yet. Check the transaction, then reload this page.`);
      setLast({ hash: txHash, text: freeze ? `${shortAccount(accountOf(w))} is frozen: the TEE refuses every signature until you unfreeze it.` : `${shortAccount(accountOf(w))} is active again, inside its policy.` });
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="hd-card overflow-hidden">
        <CardHead title="Yours" meta={`Owner ${shortAccount(owner)}`} />
        {error && <p className="px-4 py-3.5 text-[13.5px] text-danger sm:px-5">Could not read OutLayer&apos;s contract: {error}</p>}
        {!wallets && !error && <ListSkeleton rows={1} />}
        {wallets && wallets.length === 0 && <p className="px-4 py-3.5 text-[14px] text-mute sm:px-5">None yet. The first one is a few steps below.</p>}
        {wallets && wallets.length > 0 && (
          <ul className="divide-y divide-line">
            {wallets.map((w) => (
              <WalletRow
                key={w.wallet_pubkey}
                w={w}
                {...(fresh === accountOf(w) ? { label: "Made just now" } : {})}
                action={
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} aria-busy={busy === w.wallet_pubkey} onClick={() => void toggle(w)} aria-label={`${w.frozen ? "Unfreeze" : "Freeze"} ${shortAccount(accountOf(w))}`}>
                    <BusyLabel busy={busy === w.wallet_pubkey}>{w.frozen ? "Unfreeze" : "Freeze"}</BusyLabel>
                  </button>
                }
              />
            ))}
          </ul>
        )}
      </div>
      {last && (
        <p className="text-[13.5px] text-soft" role="status">
          {last.text} <TxLink hash={last.hash} />
        </p>
      )}
      <ErrorLine error={actionError} />
    </div>
  );
}

// ---------- a new wallet ----------

type StepKey = "register" | "encrypt" | "sign" | "store" | "refresh" | "fund";
const ORDER: StepKey[] = ["register", "encrypt", "sign", "store", "refresh", "fund"];

/** What only the Hushd MCP server enforces: it goes into the agent's config, not on chain. */
interface HushdLimits {
  perPayment: string;
  perDay: string;
  expire: string;
  payees: string[];
}

interface Run {
  at: StepKey;
  failed?: StepKey;
  done?: boolean;
  account?: string;
  deposit?: bigint;
  storeTx?: string;
  fundTx?: string;
  fund: bigint;
  limits: HushdLimits;
}

const DEFAULT_CAPS: Record<string, [string, string]> = { USDC: ["100", "500"], wNEAR: ["50", "250"], BTC: ["0.002", "0.01"] };
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isPayee = (p: string) => (p.startsWith("hushd1") ? isAddress(p) : ACCOUNT.test(p) && p.length >= 2 && p.length <= 64);
const today = () => new Date().toISOString().slice(0, 10);

function mcpConfig(key: string, l: HushdLimits): string {
  return [
    "# once, on the agent's machine: the seed for its private balance",
    "npx -y @hushd/mcp init",
    "",
    "# Claude Code: NEAR calls go through the policy wallet",
    "claude mcp add hushd \\",
    `  -e HUSHD_POLICY_WALLET_KEY=${key} \\`,
    `  -e HUSHD_LIMIT_PER_PAYMENT="${l.perPayment}" \\`,
    `  -e HUSHD_LIMIT_PER_DAY="${l.perDay}" \\`,
    ...(l.expire ? [`  -e HUSHD_LIMITS_EXPIRE=${l.expire} \\`] : []),
    ...(l.payees.length ? [`  -e HUSHD_ALLOW_TO="${l.payees.join(",")}" \\`] : []),
    "  -- npx -y @hushd/mcp",
  ].join("\n");
}

const num = (v: string) => v.replace(/[^\d.,]/g, "");
const int = (v: string) => v.replace(/\D/g, "");
const bad = (text: string) => <span className="text-danger">{text}</span>;

function CreateWallet({ owner, onCreated }: { owner: string; onCreated: (account: string) => Promise<void> }) {
  const s = useHushd();
  const [perTx, setPerTx] = useState("0.02");
  const [perDay, setPerDay] = useState("0.2");
  const [perHour, setPerHour] = useState("60");
  const [hoursMode, setHoursMode] = useState<"any" | "some">("any");
  const [fromHour, setFromHour] = useState("8");
  const [toHour, setToHour] = useState("20");
  const [caps, setCaps] = useState<Record<string, [string, string]>>(() => Object.fromEntries(TOKENS.map((t) => [t.id, DEFAULT_CAPS[t.symbol] ?? ["", ""]])));
  const [expire, setExpire] = useState("");
  const [payeesText, setPayeesText] = useState("");
  const [fund, setFund] = useState("0.05");

  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const runRef = useRef<Run | null>(null);
  // the new wallet, kept in memory only until the page is left
  const walletRef = useRef<{ wallet: CustodyWallet; walletId: string; account: string } | null>(null);

  // ----- the form, checked as it is typed -----
  const perTxY = nearAmount(perTx);
  const perDayY = nearAmount(perDay);
  const perHourN = perHour === "" ? NaN : Number(perHour);
  const perHourOk = Number.isInteger(perHourN) && perHourN >= 1 && perHourN <= 3600;
  const fromN = Number(fromHour);
  const toN = Number(toHour);
  const hoursOk = hoursMode === "any" || (fromHour !== "" && toHour !== "" && fromN <= 23 && toN <= 23 && fromN <= toN);
  const fundY = nearAmount(fund);
  const fundOk = fundY !== null && fundY <= 5n * 10n ** 24n;

  const capRows = TOKENS.map((t) => {
    const [one, day] = caps[t.id] ?? ["", ""];
    const oneV = one.trim() ? parseAmount(t.id, one) : null;
    const dayV = day.trim() ? parseAmount(t.id, day) : null;
    const blank = !one.trim() && !day.trim();
    const problem = blank
      ? null
      : !one.trim() || !day.trim()
        ? `${t.symbol}: set both limits, or leave both empty.`
        : oneV === null || dayV === null
          ? `${t.symbol}: not an amount ${t.symbol} can hold.`
          : dayV < oneV
            ? `${t.symbol}: the daily limit is below the limit per payment.`
            : null;
    return { t, one, day, blank, problem };
  });
  const capProblems = capRows.map((r) => r.problem).filter((p): p is string => p !== null);
  const capsSet = capRows.filter((r) => !r.blank && !r.problem);
  const payees = payeesText.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
  const badPayees = payees.filter((p) => !isPayee(p));
  const expireOk = expire === "" || expire >= today();

  const valid = perTxY !== null && perDayY !== null && perDayY >= perTxY && perHourOk && hoursOk && fundY !== null && fundOk && capProblems.length === 0 && capsSet.length > 0 && badPayees.length === 0 && expireOk;
  const form = valid
    ? {
        rules: hushdPolicyRules(NETWORK, { perTxYocto: perTxY, dailyYocto: perDayY, maxPerHour: perHourN, ...(hoursMode === "some" ? { hours: [fromN, toN] as [number, number] } : {}) }) as PolicyRules,
        limits: {
          perPayment: capsSet.map((r) => `${r.t.symbol}=${r.one.replace(/,/g, "").trim()}`).join(","),
          perDay: capsSet.map((r) => `${r.t.symbol}=${r.day.replace(/,/g, "").trim()}`).join(","),
          expire,
          payees: [...new Set(payees)],
        } satisfies HushdLimits,
        fund: fundY,
      }
    : null;

  const set = (patch: Partial<Run>) => {
    runRef.current = { ...runRef.current!, ...patch };
    setRun(runRef.current);
  };

  /** After the policy is stored: have the TEE read it now, then send the wallet NEAR for gas. */
  const finish = async (from: "refresh" | "fund") => {
    const w = walletRef.current;
    if (!w || !runRef.current) return;
    setBusy(true);
    setError(null);
    try {
      if (from === "refresh") {
        set({ at: "refresh", failed: undefined });
        await w.wallet.refresh(w.walletId);
      }
      set({ at: "fund", failed: undefined });
      const { txHash } = await s.transfer(w.account, runRef.current.fund);
      set({ fundTx: txHash, done: true });
    } catch (e) {
      set({ failed: runRef.current.at });
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!form) return;
    setError(null);
    setKey(null);
    setHidden(false);
    walletRef.current = null;
    runRef.current = { at: "register", fund: form.fund, limits: form.limits };
    setRun(runRef.current);
    setBusy(true);
    let stored = false;
    try {
      const have = await accountBalance(NETWORK, owner);
      const need = form.fund + 20n * MILLI_NEAR;
      if (have === null || have < need) {
        throw new Error(`Your account holds ${nearText(have ?? 0n)} NEAR. This needs about ${nearText(need)} NEAR: the policy's storage deposit, ${nearText(form.fund)} NEAR for the wallet's gas, and the fees.`);
      }
      const { wallet, walletId, accountId } = await CustodyWallet.register(CUST.api);
      set({ at: "encrypt", account: accountId });
      const encrypted = await wallet.encryptPolicy(walletId, form.rules);
      set({ at: "sign" });
      const signed = await wallet.signPolicy(encrypted, owner);
      const pubkey = `ed25519:${signed.publicKeyHex}`;
      const deposit = (await custodyView.cost(NETWORK, pubkey, encrypted)) + MILLI_NEAR;
      set({ at: "store", deposit });
      const { txHash } = await s.call(toChainCall(storePolicyCall(CUST.contract, signed.publicKeyHex, encrypted, signed.signatureHex, deposit)));
      set({ storeTx: txHash });
      if (!(await until(async () => (await custodyView.policy(NETWORK, pubkey))?.owner === owner))) {
        throw new Error("The chain does not show the policy yet, so the agent's key stays hidden. Check the transaction on NearBlocks before trying again.");
      }
      stored = true;
      walletRef.current = { wallet, walletId, account: accountId };
      setKey(wallet.apiKey);
      void onCreated(accountId);
    } catch (e) {
      set({ failed: runRef.current.at });
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
    if (stored) await finish("refresh");
  };

  const reset = () => {
    setRun(null);
    runRef.current = null;
    walletRef.current = null;
    setKey(null);
    setHidden(false);
    setError(null);
  };

  const state = (k: StepKey): StepState => {
    if (!run) return "todo";
    if (run.failed === k) return "failed";
    const at = ORDER.indexOf(run.at);
    const i = ORDER.indexOf(k);
    if (run.done || i < at) return "done";
    return i === at && !run.failed ? "doing" : "todo";
  };

  const steps: Step[] = run
    ? [
        {
          key: "register",
          label: "Wallet made in OutLayer's TEE",
          state: state("register"),
          detail: run.account ? `Its NEAR account is ${shortAccount(run.account)}. The key to it never leaves the TEE.` : "A new NEAR key, made and kept inside the TEE.",
        },
        { key: "encrypt", label: "Policy sealed to the TEE", state: state("encrypt"), detail: "Only the TEE can read the rules. The chain stores them sealed." },
        { key: "sign", label: `Signed for ${shortAccount(owner)}`, state: state("sign"), detail: "The wallet signs the sealed policy for your account only, so no one else can store it first." },
        {
          key: "store",
          label: "Stored on chain from your account",
          state: state("store"),
          detail: (
            <>
              {run.deposit !== undefined ? `You become its only owner. Storage deposit ${nearText(run.deposit)} NEAR.` : "You become its only owner."} {run.storeTx && <TxLink hash={run.storeTx} />}
            </>
          ),
        },
        { key: "refresh", label: "The TEE reads the new policy", state: state("refresh") },
        {
          key: "fund",
          label: `${nearText(run.fund)} NEAR sent to the wallet for gas`,
          state: state("fund"),
          detail: run.fundTx ? <TxLink hash={run.fundTx} /> : "The agent's calls pay their gas from it.",
        },
      ]
    : [];

  const afterStore = run !== null && ORDER.indexOf(run.at) > ORDER.indexOf("store");
  const tokensNamed = TOKENS.map((t) => t.symbol);

  if (run) {
    return (
      <div className="grid gap-4">
        <div className="hd-card grid gap-5 p-5 sm:p-6">
          <h2 className="t-title">{run.done ? "Your agent's policy wallet is ready" : "Creating a policy wallet"}</h2>
          <Steps steps={steps} />
          <ErrorLine error={error} />
          {run.failed && (
            <div className="flex flex-wrap gap-2">
              {afterStore ? (
                <button type="button" className="btn btn-ink btn-sm" disabled={busy} onClick={() => void finish(run.failed === "refresh" ? "refresh" : "fund")}>
                  Try this step again
                </button>
              ) : (
                <button type="button" className="btn btn-ink btn-sm" onClick={reset}>
                  Start again
                </button>
              )}
            </div>
          )}
        </div>

        {key && !hidden && (
          <div className="hd-card grid gap-4 p-5 sm:p-6">
            <div>
              <p className="t-label">The agent&apos;s key</p>
              <p role="note" className="mt-3 rounded-xl bg-warn-soft px-4 py-3 text-[13.5px] leading-relaxed text-warn">
                Shown once, here only. It is the agent&apos;s only credential: whoever holds it can ask the wallet to sign, inside your policy. Hushd does not keep it and this page forgets it when you leave. If it leaks, freeze the wallet.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-line bg-surface py-1.5 pl-3.5 pr-1.5">
              <code className="tnum min-w-0 flex-1 break-all text-[13px] text-foreground">{key}</code>
              <CopyButton text={key} label="Copy the agent's key" />
            </div>
            <p className="text-[14px] leading-relaxed text-soft">
              Give it to the agent with the MCP server. The token limits, the end date and the payees below are checked by the server, in the agent&apos;s process.
            </p>
            <CodeBlock code={mcpConfig(key, run.limits)} lang="bash" title="The agent's MCP config" />
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHidden(true)}>
                I saved it, hide the key
              </button>
            </div>
          </div>
        )}
        {key && hidden && <p className="text-[13.5px] text-mute">The key is hidden for good. Lost it? Freeze this wallet and make a new one.</p>}

        {(run.done || (run.failed && !afterStore)) && (
          <button type="button" className="btn btn-ghost w-fit" onClick={reset} disabled={busy}>
            Make another wallet
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="hd-card grid gap-7 p-5 sm:p-6">
      <div>
        <h2 className="t-title">Create a policy wallet for your agent</h2>
        <p className="mt-1.5 max-w-[62ch] text-[14px] leading-relaxed text-mute">
          Owned by {shortAccount(owner)}. You sign two transactions: storing the policy, with a storage deposit of about 0.012 NEAR, and the NEAR the wallet spends on gas.
        </p>
      </div>

      <fieldset className="grid gap-4" aria-labelledby="tee-rules">
        <div>
          <p id="tee-rules" className="text-[14.5px] font-medium text-foreground">
            Checked by the TEE before every signature
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-mute">Contract calls only, and only to Hushd&apos;s contracts: the pool, the desk, the board and the {tokensNamed.slice(0, -1).join(", ")} and {tokensNamed.at(-1)} tokens.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="NEAR per transaction" hint={perTxY === null ? bad("A NEAR amount, like 0.02.") : "Attached to one call, at most."}>
            <input className="hd-input tnum" inputMode="decimal" autoComplete="off" value={perTx} onChange={(e) => setPerTx(num(e.target.value))} aria-label="NEAR per transaction" />
          </Field>
          <Field label="NEAR per day" hint={perDayY === null ? bad("A NEAR amount, like 0.2.") : perTxY !== null && perDayY < perTxY ? bad("Below the limit per transaction.") : "Attached in one UTC day, at most."}>
            <input className="hd-input tnum" inputMode="decimal" autoComplete="off" value={perDay} onChange={(e) => setPerDay(num(e.target.value))} aria-label="NEAR per day" />
          </Field>
          <Field label="Calls per hour" hint={perHourOk ? "Signatures in any hour, at most." : bad("A whole number from 1 to 3,600.")}>
            <input className="hd-input tnum" inputMode="numeric" autoComplete="off" value={perHour} onChange={(e) => setPerHour(int(e.target.value))} aria-label="Calls per hour" />
          </Field>
        </div>
        <Field label="Hours, in UTC" hint={hoursMode === "any" ? "The wallet may sign at any hour." : hoursOk ? `It signs only from ${fromHour.padStart(2, "0")}:00 to the end of hour ${toHour.padStart(2, "0")}, UTC.` : bad("Two hours from 0 to 23, the first no later than the second.")}>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label="Hours"
              value={hoursMode}
              onChange={setHoursMode}
              options={[
                { value: "any", label: "Any time" },
                { value: "some", label: "Only some hours" },
              ]}
            />
            {hoursMode === "some" && (
              <div className="flex items-center gap-2 text-[14px] text-mute">
                <input className="hd-input tnum w-[4.5rem] text-center" inputMode="numeric" autoComplete="off" value={fromHour} onChange={(e) => setFromHour(int(e.target.value).slice(0, 2))} aria-label="From hour, UTC" />
                to
                <input className="hd-input tnum w-[4.5rem] text-center" inputMode="numeric" autoComplete="off" value={toHour} onChange={(e) => setToHour(int(e.target.value).slice(0, 2))} aria-label="To hour, UTC" />
              </div>
            )}
          </div>
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 border-t border-line pt-6" aria-labelledby="mcp-rules">
        <div>
          <p id="mcp-rules" className="text-[14.5px] font-medium text-foreground">
            Checked by the Hushd MCP server before every payment
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-mute">Token amounts sit inside call arguments, which the TEE does not read. These go into the agent&apos;s config, not on chain.</p>
        </div>
        <div className="grid grid-cols-[3.75rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 gap-y-2 sm:max-w-[34rem] sm:grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)]">
          <span aria-hidden />
          <span className="t-label">Per payment</span>
          <span className="t-label">Per day</span>
          {capRows.map(({ t, one, day }) => (
            <div key={t.id} className="contents">
              <span className="text-[14px] text-foreground">{t.symbol}</span>
              <input className="hd-input tnum" inputMode="decimal" autoComplete="off" placeholder="None" value={one} onChange={(e) => setCaps((c) => ({ ...c, [t.id]: [num(e.target.value), c[t.id]?.[1] ?? ""] }))} aria-label={`${t.symbol} per payment`} />
              <input className="hd-input tnum" inputMode="decimal" autoComplete="off" placeholder="None" value={day} onChange={(e) => setCaps((c) => ({ ...c, [t.id]: [c[t.id]?.[0] ?? "", num(e.target.value)] }))} aria-label={`${t.symbol} per day`} />
            </div>
          ))}
        </div>
        <p className="-mt-1 text-[12.5px] text-mute">
          {capProblems.length > 0 ? bad(capProblems[0]!) : capsSet.length === 0 ? bad("Set limits for at least one token.") : "A token left empty cannot be spent."}
        </p>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
          <Field label="Limits end on" hint={expireOk ? (expire ? "From this UTC day, the agent may not spend." : "Optional. Empty means they never end.") : bad("A day from today on.")}>
            <input className="hd-input tnum" type="date" min={today()} value={expire} onChange={(e) => setExpire(e.target.value)} aria-label="Limits end on" />
          </Field>
          <Field label="Who it may pay" hint={badPayees.length > 0 ? bad(`Not a hushd1… address or NEAR account: ${shortAccount(badPayees[0]!)}`) : "Optional. hushd1… addresses or NEAR accounts, separated by commas. Empty means anyone."}>
            <input className="hd-input" autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="Anyone" value={payeesText} onChange={(e) => setPayeesText(e.target.value)} aria-label="Who it may pay" />
          </Field>
        </div>
      </fieldset>

      <div className="grid gap-4 border-t border-line pt-6">
        <Field label="NEAR for the wallet's gas" hint={fundOk ? `Sent from ${shortAccount(owner)} to the new wallet's account.` : bad("A NEAR amount up to 5, like 0.05.")}>
          <input className="hd-input tnum sm:max-w-[12rem]" inputMode="decimal" autoComplete="off" value={fund} onChange={(e) => setFund(num(e.target.value))} aria-label="NEAR for the wallet's gas" />
        </Field>
        <button type="button" className="btn btn-ink btn-lg btn-block" disabled={!form || busy} onClick={() => void create()}>
          Create the policy wallet
        </button>
      </div>
    </div>
  );
}

function YourSide() {
  const s = useHushd();
  const owner = s.accountId!;
  const { wallets, error, load } = useOwnerWallets(owner);
  const [fresh, setFresh] = useState<string | null>(null);
  const onCreated = useCallback(
    async (account: string) => {
      setFresh(account);
      await load();
    },
    [load],
  );
  return (
    <div className="grid gap-4">
      <YourWallets owner={owner} wallets={wallets} error={error} reload={load} fresh={fresh} />
      <CreateWallet owner={owner} onCreated={onCreated} />
    </div>
  );
}

const TEE_RULES = [
  "Contract calls only, and only to Hushd's contracts",
  "NEAR attached per transaction and per day",
  "Calls per hour",
  "Hours of the day, in UTC, when you set them",
  "Your freeze: a frozen wallet signs nothing",
];
const MCP_RULES = [
  "Token amounts per payment and per day, since the TEE does not read call arguments",
  "The day the limits end",
  "Who the agent may pay",
  "No spending at all while the wallet is frozen",
];

function RuleList({ title, sub, items }: { title: string; sub: string; items: string[] }) {
  return (
    <div className="grid content-start gap-3 p-5 sm:p-6">
      <div>
        <p className="text-[14.5px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-[12.5px] text-mute">{sub}</p>
      </div>
      <ul className="grid gap-2">
        {items.map((r) => (
          <li key={r} className="flex gap-2.5 text-[13.5px] leading-relaxed text-soft">
            <span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-line-strong" />
            {r}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The Policy wallets part of the Agents page. `owner` owns Hushd's own agents' wallets, or is null where Hushd runs none. */
export function PolicyWallets({ owner, labels }: { owner: string | null; labels: WalletLabel[] }) {
  const s = useHushd();
  return (
    <>
      <section className="grid gap-3" aria-labelledby="policy-wallets">
        <p id="policy-wallets" className="t-label">
          Policy wallets
        </p>
        <p className="text-[14.5px] leading-relaxed text-soft">
          An agent that needs its own NEAR account can have one without ever holding its key. The key is made and kept in OutLayer&apos;s TEE; the agent holds only an API key, and the TEE checks the owner&apos;s policy before every signature. The owner stores the policy on chain and is the only account that can freeze it.
        </p>
        {owner && <HushdWallets owner={owner} labels={labels} />}
      </section>

      <section className="grid gap-3" aria-labelledby="who-enforces">
        <p id="who-enforces" className="t-label">
          Who enforces what
        </p>
        <div className="hd-card overflow-hidden">
          <div className="grid divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <RuleList title="OutLayer's TEE" sub="Before every signature, whatever asks for it" items={TEE_RULES} />
            <RuleList title="The Hushd MCP server" sub="Before every payment, in the agent's own process" items={MCP_RULES} />
          </div>
          <p className="border-t border-line px-5 py-3.5 text-[13px] leading-relaxed text-mute sm:px-6">
            The TEE&apos;s rules hold even if the agent&apos;s machine is taken over. The server&apos;s limits run beside the agent: they stop an agent that gets it wrong, but whoever holds the key can call the TEE directly, inside the TEE&apos;s rules.
          </p>
        </div>
      </section>

      <section className="grid gap-3" aria-labelledby="your-wallets">
        <p id="your-wallets" className="t-label">
          Your policy wallets
        </p>
        {s.canSign && s.accountId ? <YourSide key={s.accountId} /> : <OwnerSignIn />}
      </section>
    </>
  );
}
