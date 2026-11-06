"use client";

import { txUrl } from "@hushd/sdk";
import type { ReactNode } from "react";
import { Select } from "@/components/ui/Select";
import { NETWORK } from "@/lib/hushd/config";
import { fmt, TOKENS } from "@/lib/hushd/format";

export function TokenSelect({ value, onChange, label = "Token", balances }: { value: string; onChange: (v: string) => void; label?: string; balances?: Map<string, bigint> }) {
  return (
    <Select
      value={value}
      onChange={onChange}
      label={label}
      variant="pill"
      options={TOKENS.map((t) => ({
        value: t.id,
        label: t.symbol,
        ...(balances ? { description: `${fmt(t.id, balances.get(t.id) ?? 0n)} private` } : {}),
      }))}
    />
  );
}

/** The big amount card: a number, the token beside it (or another `picker`), and a line underneath. */
export function AmountCard({ label, value, onChange, token, onToken, note, balances, picker }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  token?: string;
  onToken?: (v: string) => void;
  note?: ReactNode;
  balances?: Map<string, bigint>;
  picker?: ReactNode;
}) {
  return (
    <div className="hd-inputcard p-4 sm:p-5">
      <label className="t-label" htmlFor="amount">{label}</label>
      <div className="mt-2 flex items-center gap-3">
        <input
          id="amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ""))}
          className="hd-amount tnum w-0 min-w-0 flex-1 bg-transparent text-[34px] font-light tracking-[-0.02em] text-foreground outline-none placeholder:text-faint sm:text-[40px]"
        />
        {picker ?? (token !== undefined && onToken && <TokenSelect value={token} onChange={onToken} balances={balances} />)}
      </div>
      {note && <div className="mt-2 text-[13px] text-mute">{note}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div>
      <p className="t-label mb-2">{label}</p>
      {children}
      {hint && <p className="mt-1.5 text-[12.5px] text-mute">{hint}</p>}
    </div>
  );
}

export function TxLine({ hash, children }: { hash: string; children: ReactNode }) {
  return (
    <p className="text-[13.5px] text-soft [overflow-wrap:anywhere]">
      {children}{" "}
      {hash && (
        <a href={txUrl(NETWORK, hash)} target="_blank" rel="noreferrer" className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
          View on NearBlocks
        </a>
      )}
    </p>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="text-[13.5px] text-danger" role="alert">{error}</p> : null;
}
