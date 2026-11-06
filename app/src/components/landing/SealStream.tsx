import { PauseOffscreen } from "@/components/ui/PauseOffscreen";
import { SealDots } from "@/components/ui/SealDots";
import styles from "./landing.module.css";

/** The kinds of request the desk takes, on the test tokens it lists. Words only: no amounts. */
const REQUESTS = [
  { kind: "Spot", sell: "USDC", buy: "wNEAR" },
  { kind: "Spot + hedge", sell: "USDC", buy: "BTC" },
  { kind: "Cash and carry", sell: "USDC", buy: "wNEAR" },
  { kind: "Spot", sell: "BTC", buy: "USDC" },
  { kind: "Spot + hedge", sell: "USDC", buy: "wNEAR" },
  { kind: "Spot", sell: "wNEAR", buy: "BTC" },
  { kind: "Cash and carry", sell: "USDC", buy: "BTC" },
];

function Readable({ r }: { r: (typeof REQUESTS)[number] }) {
  return (
    <div className={styles.card}>
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-mute">{r.kind}</span>
        <span className="text-[12px] text-faint">Your request</span>
      </div>
      <div>
        <p className="text-[15px] text-foreground">
          Sell {r.sell}, buy {r.buy}
        </p>
        <p className="mt-1 text-[13px] text-mute">Your size and your limit</p>
      </div>
    </div>
  );
}

function Sealed() {
  return (
    <div className={styles.card}>
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-mute">open_rfq</span>
        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-sealed">
          <span className="h-1.5 w-1.5 rounded-full bg-sealed" />
          Sealed
        </span>
      </div>
      <div>
        <p className="text-[15px] text-foreground">
          sha256 <SealDots n={6} className="ml-1 text-foreground/70" label="Hash of the sealed request" />
        </p>
        <p className="mt-1 text-[13px] text-mute">Opened only in the enclave</p>
      </div>
    </div>
  );
}

/** The signature: a request enters readable and the chain records only its hash. */
export function SealStream() {
  const loop = [...REQUESTS, ...REQUESTS];
  return (
    <PauseOffscreen
      className={styles.stream}
      role="img"
      aria-label="Trade requests going in readable and coming out as a sealed hash on chain"
    >
      <div className={`${styles.half} ${styles.readable}`} aria-hidden>
        <div className={`${styles.track} ${styles.move}`}>
          {loop.map((r, i) => (
            <Readable key={i} r={r} />
          ))}
        </div>
      </div>
      <div className={`${styles.half} ${styles.sealed}`} aria-hidden>
        <div className={`${styles.track} ${styles.move}`}>
          {loop.map((_, i) => (
            <Sealed key={i} />
          ))}
        </div>
      </div>
      <div className={styles.slab} aria-hidden>
        <div className={styles.slabGlow} />
      </div>
    </PauseOffscreen>
  );
}
