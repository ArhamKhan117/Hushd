"use client";

import { artifactsAt, isAddress, linkUrl, payAsLink, removeUnsentLink, sentLinks, takeBackLink, type LinkState, type SentLink } from "@hushd/sdk";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppShell } from "@/components/app/AppShell";
import { Segmented } from "@/components/app/desk";
import { AmountCard, ErrorLine, Field, TxLine } from "@/components/app/forms";
import { SignInPanel } from "@/components/app/SignInPanel";
import { CopyButton } from "@/components/ui/CodeBlock";
import { BusyLabel } from "@/components/ui/Spinner";
import { CIRCUITS_BASE } from "@/lib/hushd/config";
import { StateDot, when } from "@/lib/hushd/deal";
import { fmt, parseAmount, symbol, TOKENS } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

type Mode = "address" | "link";

const STATE: Record<LinkState, { word: string; tone: "ok" | "wait" | "bad" }> = {
  sending: { word: "Sending", tone: "wait" },
  waiting: { word: "Waiting", tone: "wait" },
  claimed: { word: "Claimed", tone: "ok" },
  "taken back": { word: "Taken back", tone: "ok" },
  "not sent": { word: "Not sent", tone: "bad" },
};

const claimUrl = (l: SentLink["link"]) => linkUrl(location.origin, l);

export default function SendPage() {
  const s = useHushd();
  // A payment request link fills the form: /app/balance/send#to=…&token=…&amount=…
  const hash = useSyncExternalStore(subscribeHash, () => location.hash, () => "");
  const request = new URLSearchParams(hash.slice(1));
  const requestToken = TOKENS.some((t) => t.id === request.get("token")) ? request.get("token")! : null;
  const [mode, setMode] = useState<Mode>("address");
  const [typedTo, setTo] = useState<string | null>(null);
  const [typedToken, setToken] = useState<string | null>(null);
  const [typedInput, setInput] = useState<string | null>(null);
  const [typedMemo, setMemo] = useState<string | null>(null);
  const to = typedTo ?? request.get("to") ?? "";
  const token = typedToken ?? requestToken ?? TOKENS[0]!.id;
  const input = typedInput ?? request.get("amount") ?? "";
  const memo = typedMemo ?? request.get("memo") ?? "";
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [done, setDone] = useState<{ hash: string; text: string } | null>(null);
  const [made, setMade] = useState<{ link: SentLink["link"]; code: string; hash: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<SentLink[] | null>(null);
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<{ code: string; message: string } | null>(null);

  const amount = parseAmount(token, input);
  const have = s.balances.get(token) ?? 0n;
  const validTo = isAddress(to.trim());
  const tooMuch = amount !== null && amount > have;

  const wallet = s.wallet;
  const refreshLinks = useCallback(async () => {
    if (!wallet) return;
    // a failed read keeps the last states shown
    const next = await sentLinks(wallet).catch(() => null);
    if (next) setLinks(next);
  }, [wallet]);
  // read again after every sync (the session syncs every 20 seconds)
  useEffect(() => {
    let live = true;
    if (wallet) sentLinks(wallet).then((next) => live && setLinks(next), () => undefined);
    return () => {
      live = false;
    };
  }, [wallet, s.balances]);

  const send = async () => {
    if (!s.wallet || amount === null) return;
    setBusy(true);
    setError(null);
    try {
      setStep("Proving in your browser…");
      const r = await s.wallet.send(to.trim(), token, amount, memo || undefined);
      setDone({ hash: r.txHash, text: `Sent ${fmt(token, amount)} ${symbol(token)} privately. The recipient finds it on the board; nobody else learns who or how much.` });
      setInput("");
      void s.sync();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  const makeLink = async () => {
    if (!s.wallet || amount === null) return;
    setBusy(true);
    setError(null);
    setMade(null);
    try {
      setStep("Proving in your browser…");
      const r = await payAsLink(s.wallet, token, amount);
      setMade({ link: r.link, code: r.code, hash: r.txHash });
      setInput("");
      void refreshLinks();
      void s.sync();
    } catch (e) {
      setError((e as Error).message);
      void refreshLinks();
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  const onLink = (l: SentLink, action: "take back" | "remove") => async () => {
    if (!s.wallet) return;
    setLinkBusy(l.code);
    setLinkError(null);
    try {
      if (action === "take back") await takeBackLink(s.wallet, l.link, { artifacts: artifactsAt(CIRCUITS_BASE), relayer: s.relayer });
      else await removeUnsentLink(s.wallet, l.link);
      if (made?.code === l.code) setMade(null);
      void s.sync();
    } catch (e) {
      setLinkError({ code: l.code, message: (e as Error).message });
    } finally {
      setLinkBusy(null);
      await refreshLinks();
    }
  };

  return (
    <AppShell title="Send privately" subtitle="Pay a Hushd address, or anyone as a link. The relayer sends it, so your NEAR account never appears.">
      {s.status !== "ready" ? (
        <SignInPanel />
      ) : (
        <div className="grid gap-6">
          <div className="grid max-w-[560px] gap-4">
            <Segmented
              label="Send to"
              value={mode}
              onChange={(m) => {
                setMode(m);
                setError(null);
              }}
              options={[
                { value: "address", label: "To a Hushd address" },
                { value: "link", label: "As a link" },
              ]}
            />
            {mode === "address" ? (
              <>
                <Field label="To" hint={to && !validTo ? "That is not a Hushd address (hushd1…)." : "A hushd1… receive address."}>
                  <input className="hd-input w-full" placeholder="hushd1…" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
                </Field>
                <AmountCard label="Amount" value={input} onChange={setInput} token={token} onToken={setToken} balances={s.balances} note={`Private balance: ${fmt(token, have)} ${symbol(token)}`} />
                <Field label="Note to the recipient (optional)" hint="Encrypted to them with the payment.">
                  <input className="hd-input w-full" value={memo} maxLength={120} onChange={(e) => setMemo(e.target.value)} />
                </Field>
                <button type="button" className="btn btn-ink btn-lg btn-block" disabled={!validTo || amount === null || tooMuch || busy} onClick={send} aria-busy={busy}>
                  <BusyLabel busy={busy} busyText={step || "Sending…"}>{tooMuch ? "More than your private balance" : "Send privately"}</BusyLabel>
                </button>
                {done && <TxLine hash={done.hash}>{done.text}</TxLine>}
              </>
            ) : (
              <>
                <AmountCard label="Amount" value={input} onChange={setInput} token={token} onToken={setToken} balances={s.balances} note={`Private balance: ${fmt(token, have)} ${symbol(token)}`} />
                <p className="text-[13px] leading-relaxed text-mute">
                  You get a link to share. Whoever opens it first claims the payment into their own private balance, with a passkey or a NEAR wallet and no gas. Until
                  then you can take it back.
                </p>
                <button type="button" className="btn btn-ink btn-lg btn-block" disabled={amount === null || tooMuch || busy} onClick={makeLink} aria-busy={busy}>
                  <BusyLabel busy={busy} busyText={step || "Making the link…"}>{tooMuch ? "More than your private balance" : "Make a link"}</BusyLabel>
                </button>
                {/* the new link stays in view until it is claimed or taken back */}
                {made && ["sending", "waiting", undefined].includes(links?.find((l) => l.code === made.code)?.state) && <MadeLink link={made.link} hash={made.hash} />}
              </>
            )}
            <ErrorLine error={error} />
          </div>

          {mode === "link" && links && links.length > 0 && (
            <section className="grid max-w-[560px] gap-3" aria-labelledby="sent-links">
              <p id="sent-links" className="t-label">
                Sent links
              </p>
              <ul className="hd-card divide-y divide-line">
                {links.map((l) => {
                  const st = STATE[l.state];
                  return (
                    <li key={l.code} data-link-state={l.state} className="grid gap-2 px-4 py-3.5 sm:px-5">
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                        <span className="min-w-0">
                          <span className="tnum block text-[14.5px] text-foreground">
                            {fmt(l.link.token, l.link.amount)} {symbol(l.link.token)}
                          </span>
                          <span className="block text-[12.5px] text-mute">{when(l.atMs)}</span>
                        </span>
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <span className="flex items-center gap-2 text-[13px] text-soft">
                            <StateDot tone={st.tone} />
                            {st.word}
                          </span>
                          {l.state === "waiting" && <CopyButton text={claimUrl(l.link)} label={`Copy the link for ${fmt(l.link.token, l.link.amount)} ${symbol(l.link.token)}`} />}
                          {(l.state === "waiting" || l.state === "not sent") && (
                            <button type="button" className="btn btn-ghost btn-sm" disabled={linkBusy !== null} aria-busy={linkBusy === l.code} onClick={onLink(l, l.state === "waiting" ? "take back" : "remove")}>
                              <BusyLabel busy={linkBusy === l.code} busyText={l.state === "waiting" ? "Taking back…" : undefined}>
                                {l.state === "waiting" ? "Take back" : "Remove"}
                              </BusyLabel>
                            </button>
                          )}
                        </span>
                      </div>
                      {linkError?.code === l.code && <ErrorLine error={linkError.message} />}
                    </li>
                  );
                })}
              </ul>
              <p className="text-[12.5px] leading-relaxed text-mute">
                Only this browser keeps your links. Taking one back pays it back to you, and the link stops working.
              </p>
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}

function MadeLink({ link, hash }: { link: SentLink["link"]; hash: string }) {
  const url = claimUrl(link);
  return (
    <div className="hd-card grid gap-3 p-4 sm:p-5" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <p className="t-label">
          Your link · <span className="tnum">{fmt(link.token, link.amount)} {symbol(link.token)}</span>
        </p>
        <CopyButton text={url} label="Copy link" className="-my-1.5 -mr-2" />
      </div>
      <p className="break-all rounded-xl bg-surface px-3 py-2.5 text-[13px] leading-relaxed text-soft" aria-label="Claim link">
        {url}
      </p>
      <p className="text-[13.5px] text-foreground">Anyone with this link can claim it. Share it privately.</p>
      <TxLine hash={hash}>Paid privately into the link.</TxLine>
    </div>
  );
}
