"use client";

import { IS_TESTNET, NETWORK } from "@/lib/hushd/config";
import { ago } from "./pairs";
import { useNow, type Network, type Polled } from "./useMarket";

function Dot({ ok }: { ok: boolean | null }) {
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${ok === null ? "bg-line-strong" : ok ? "bg-accent" : "bg-danger"}`} />;
}

/** "owner/project@<wasm sha256>" when the desk pins the matcher's build, else the project alone. */
function build(project: string): { name: string; hash: string | null } {
  const [name, hash] = project.split("@");
  return { name: name ?? project, hash: hash ?? null };
}

/** The thin line along the foot of the screen: where this runs and whether its parts answer. */
export function StatusBar({ net, pricesAt }: { net: Polled<Network>; pricesAt: number }) {
  const now = useNow(1_000);
  const n = net.data;
  const b = n ? build(n.enclave.project) : null;
  const blockAge = n ? now - n.block.timestampMs : null;
  return (
    <section className="tt-status border border-line" aria-label="Network status">
      <span>
        <Dot ok={n ? true : net.error ? false : null} />
        <b>NEAR {NETWORK.id}</b>
        <span className="text-faint">{IS_TESTNET ? "test tokens" : "real tokens"}</span>
      </span>
      <span title="The latest final block, read from NEAR RPC">
        Block <b>{n ? n.block.height.toLocaleString("en-US") : "-"}</b>
        {blockAge !== null && <span className="text-faint">{ago(n!.block.timestampMs, Math.max(now, n!.block.timestampMs))}</span>}
      </span>
      <span title={b ? `The desk accepts matches only from ${n!.enclave.project}` : undefined}>
        <Dot ok={n ? Boolean(b?.hash) : null} />
        Matcher {b?.hash ? <b>{`${b.hash.slice(0, 8)}…${b.hash.slice(-4)}`}</b> : <b>{b ? "not pinned" : "-"}</b>}
        {b?.hash && <span className="text-faint">pinned</span>}
      </span>
      <span title={n?.relayer.detail}>
        <Dot ok={n ? n.relayer.ok : null} />
        Relayer <b>{n ? (n.relayer.ok ? n.relayer.detail : "down") : "-"}</b>
      </span>
      <span title={n?.indexer.detail}>
        <Dot ok={n ? n.indexer.ok : null} />
        Indexer <b>{n ? (n.indexer.ok ? n.indexer.detail : "down") : "-"}</b>
      </span>
      <span className="lg:ml-auto">
        Prices <b>{pricesAt ? ago(pricesAt, Math.max(now, pricesAt)) : "-"}</b>
      </span>
    </section>
  );
}
