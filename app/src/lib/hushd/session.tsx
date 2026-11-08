"use client";

/**
 * The app session: who is signed in (a NEAR wallet through NEAR Connect, or a passkey
 * with its own implicit account), the Hushd identity derived from it, and the private
 * wallet that holds this identity's notes. Notes are kept in this browser encrypted
 * with a key from the same seed, and every self note is also on the board, so a new
 * device recovers everything from the seed alone.
 */
import {
  artifactsAt,
  identityFromSeed,
  keepRpcErrorBodies,
  loadPoseidon,
  PrivateWallet,
  RelayerClient,
  restEndpoint,
  rpcOrder,
  SEED_MESSAGE,
  sendEndpoints,
  seedFromSignature,
  type Identity,
  type NoteStore,
  type WalletState,
} from "@hushd/sdk";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CIRCUITS_BASE, IS_TESTNET, NETWORK } from "./config";
import { b64ToBytes, createPasskey, nearKeyFromSeed, SEED_NONCE, SEED_RECIPIENT, storeKey, unlockPasskey } from "./keys";

export interface ChainCall {
  contract: string;
  method: string;
  args: Record<string, unknown>;
  gas?: string;
  deposit?: string;
}

interface Signer {
  accountId: string;
  kind: "wallet" | "passkey";
  call(c: ChainCall): Promise<{ txHash: string }>;
  /** Send `yocto` NEAR from the signed-in account to `to`. */
  transfer(to: string, yocto: bigint): Promise<{ txHash: string }>;
}

export type SessionStatus = "loading" | "signed-out" | "connected" | "ready";

interface Session {
  status: SessionStatus;
  accountId: string | null;
  kind: "wallet" | "passkey" | null;
  identity: Identity | null;
  wallet: PrivateWallet | null;
  relayer: RelayerClient;
  error: string | null;
  balances: Map<string, bigint>;
  syncing: boolean;
  connectWallet(): Promise<void>;
  createPasskeyAccount(): Promise<void>;
  unlockWithPasskey(): Promise<void>;
  /** Wallet users: sign the seed message to open the private balance. */
  unlock(): Promise<void>;
  signOut(): Promise<void>;
  sync(): Promise<void>;
  /** True when this session can sign NEAR transactions now (a passkey account signs after unlock). */
  canSign: boolean;
  call(c: ChainCall): Promise<{ txHash: string }>;
  transfer(to: string, yocto: bigint): Promise<{ txHash: string }>;
}

const Ctx = createContext<Session | null>(null);

/** NEAR RPC answers "Server error" for a refused transaction; say why in words. */
function readableChainError(e: unknown): string {
  const text = JSON.stringify((e as { data?: unknown }).data ?? "") + String((e as Error).message ?? e);
  if (text.includes("NotEnoughBalance")) return "Your NEAR account does not have enough NEAR to pay for this transaction's gas.";
  if (text.includes("InvalidNonce")) return "Another transaction from this account is in flight; try again in a moment.";
  const panic = /Smart contract panicked: ([^"\\]+)/.exec(text);
  if (panic) return panic[1]!;
  return (e as Error).message ?? "The transaction failed";
}
const PASSKEY_FLAG = "hushd.passkey.account";

class EncryptedLocalStore implements NoteStore {
  constructor(private readonly key: CryptoKey, private readonly slot: string) {}
  async load() {
    const raw = localStorage.getItem(this.slot);
    if (!raw) return null;
    try {
      const bytes = b64ToBytes(raw);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, this.key, bytes.slice(12));
      return JSON.parse(new TextDecoder().decode(plain)) as WalletState;
    } catch {
      return null;
    }
  }
  async save(state: WalletState) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, new TextEncoder().encode(JSON.stringify(state))));
    const all = new Uint8Array(12 + ct.length);
    all.set(iv);
    all.set(ct, 12);
    localStorage.setItem(this.slot, btoa(String.fromCharCode(...all)));
  }
}

let connectorPromise: Promise<import("@hot-labs/near-connect").NearConnector> | undefined;
function connector() {
  connectorPromise ??= import("@hot-labs/near-connect").then(
    // list only the wallets that sign on this network
    ({ NearConnector }) => new NearConnector({ network: NETWORK.id, features: { signMessage: true, [NETWORK.id]: true } }),
  );
  return connectorPromise;
}

export function HushdProvider({ children }: { children: ReactNode }) {
  const relayer = useMemo(() => new RelayerClient(NETWORK.api), []);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [signer, setSigner] = useState<Signer | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [wallet, setWallet] = useState<PrivateWallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  const [syncing, setSyncing] = useState(false);
  const syncRef = useRef<Promise<void> | null>(null);

  const open = useCallback(async (seed: Uint8Array, s: Signer) => {
    await loadPoseidon();
    const id = identityFromSeed(seed);
    const store = new EncryptedLocalStore(await storeKey(seed), `hushd.notes.${NETWORK.id}.${id.address.slice(-16)}`);
    const w = new PrivateWallet(NETWORK, id, { artifacts: artifactsAt(CIRCUITS_BASE), relayer, store });
    await w.restore();
    setIdentity(id);
    setWallet(w);
    setSigner(s);
    setBalances(w.balances());
    setStatus("ready");
  }, [relayer]);

  const walletSigner = useCallback(async (accountId: string): Promise<Signer> => {
    const c = await connector();
    return {
      accountId,
      kind: "wallet",
      async call(x) {
        const w = await c.wallet();
        const out = (await w.signAndSendTransaction({
          receiverId: x.contract,
          actions: [{ type: "FunctionCall", params: { methodName: x.method, args: x.args, gas: x.gas ?? "100000000000000", deposit: x.deposit ?? "0" } }],
        } as never)) as { transaction?: { hash?: string } };
        return { txHash: out?.transaction?.hash ?? "" };
      },
      async transfer(to, yocto) {
        const w = await c.wallet();
        const out = (await w.signAndSendTransaction({
          receiverId: to,
          actions: [{ type: "Transfer", params: { deposit: yocto.toString() } }],
        } as never)) as { transaction?: { hash?: string } };
        return { txHash: out?.transaction?.hash ?? "" };
      },
    };
  }, []);

  const passkeySigner = useCallback(async (seed: Uint8Array): Promise<Signer> => {
    const k = nearKeyFromSeed(seed);
    const { Near } = await import("near-kit");
    keepRpcErrorBodies(NETWORK.rpc);
    // one client per endpoint that takes transactions
    const clients = new Map(sendEndpoints(NETWORK).map((rpcUrl) => [rpcUrl, new Near({ network: { networkId: NETWORK.id, rpcUrl }, privateKey: k.secretKey as `ed25519:${string}`, defaultSignerId: k.implicitAccount })]));
    type Builder = ReturnType<InstanceType<typeof Near>["transaction"]>;
    /**
     * Signs once and sends those exact bytes, failing over to the next endpoint when one
     * cannot be reached (a free RPC that rate-limits answers without CORS headers, so the
     * browser sees only "Failed to fetch"). Resending the same signed bytes is safe: a node
     * accepts one transaction hash at most once. Only a stale nonce, which proves the
     * transaction was refused, hands it to near-kit's own send, which signs again.
     */
    const send = async (build: (near: InstanceType<typeof Near>) => Builder): Promise<{ txHash: string }> => {
      const order = rpcOrder([...clients.keys()]);
      let bytes: Uint8Array | null = null;
      let last: unknown = null;
      for (let attempt = 0; attempt < order.length * 3; attempt++) {
        const url = order[attempt % order.length]!;
        const near = clients.get(url)!;
        try {
          if (!bytes) bytes = (await build(near).sign()).serialize();
          const out = (await near.rpc.sendTransaction(bytes, "EXECUTED_OPTIMISTIC")) as unknown as { transaction?: { hash?: string } };
          return { txHash: out?.transaction?.hash ?? "" };
        } catch (e) {
          last = e;
          const msg = `${(e as Error).name ?? ""} ${(e as Error).message ?? ""}`;
          if (/InvalidNonce|nonce/i.test(msg) && !/fetch/i.test(msg)) {
            // refused, so nothing went out: near-kit's own send refreshes its cached nonce and retries
            try {
              const out = (await build(near).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as unknown as { transaction?: { hash?: string } };
              return { txHash: out?.transaction?.hash ?? "" };
            } catch (again) {
              throw new Error(readableChainError(again));
            }
          }
          if (!/Failed to fetch|fetch failed|Load failed|NetworkError|Network request failed|429|too many|rate.?limit|timed? ?out/i.test(msg)) break;
          restEndpoint(url);
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      throw new Error(readableChainError(last));
    };
    return {
      accountId: k.implicitAccount,
      kind: "passkey",
      call: (x) =>
        send((near) =>
          near
            .transaction(k.implicitAccount)
            .functionCall(x.contract, x.method, x.args, { gas: `${Number(BigInt(x.gas ?? "100000000000000") / 1_000_000_000_000n)} Tgas` as `${number} Tgas`, attachedDeposit: BigInt(x.deposit ?? "0") }),
        ),
      transfer: (to, yocto) => send((near) => near.transaction(k.implicitAccount).transfer(to, yocto)),
    };
  }, []);

  // Restore a wallet connection on load (the private balance stays locked until unlock()).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await connector();
        c.on("wallet:signOut", () => {
          setSigner(null);
          setIdentity(null);
          setWallet(null);
          setStatus("signed-out");
        });
        const w = await c.wallet().catch(() => null);
        const accounts = w ? await w.getAccounts().catch(() => []) : [];
        if (!alive) return;
        if (accounts[0]) {
          setSigner(await walletSigner(accounts[0].accountId));
          setStatus("connected");
        } else {
          setStatus(localStorage.getItem(PASSKEY_FLAG) ? "connected" : "signed-out");
        }
      } catch {
        if (alive) setStatus("signed-out");
      }
    })();
    return () => {
      alive = false;
    };
  }, [walletSigner]);

  const run = useCallback(async (f: () => Promise<void>) => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, []);

  const connectWallet = useCallback(() => run(async () => {
    const c = await connector();
    const w = await c.connect();
    const accounts = await w.getAccounts();
    if (!accounts[0]) throw new Error("The wallet returned no account");
    localStorage.removeItem(PASSKEY_FLAG);
    setSigner(await walletSigner(accounts[0].accountId));
    setStatus("connected");
  }), [run, walletSigner]);

  const unlock = useCallback(() => run(async () => {
    if (localStorage.getItem(PASSKEY_FLAG)) {
      const seed = await unlockPasskey();
      await open(seed, await passkeySigner(seed));
      return;
    }
    const c = await connector();
    const w = await c.wallet();
    const signed = await w.signMessage({ message: SEED_MESSAGE, recipient: SEED_RECIPIENT, nonce: SEED_NONCE } as never);
    const sig = (signed as { signature: string }).signature;
    const accounts = await w.getAccounts();
    await open(seedFromSignature(b64ToBytes(sig)), await walletSigner(accounts[0]!.accountId));
  }), [open, passkeySigner, run, walletSigner]);

  const createPasskeyAccount = useCallback(() => run(async () => {
    const seed = await createPasskey();
    const s = await passkeySigner(seed);
    localStorage.setItem(PASSKEY_FLAG, s.accountId);
    // On testnet the relayer opens the implicit account with a little NEAR for gas. On
    // mainnet it does not: the account waits for NEAR sent to it (FundGas on the Add page).
    if (IS_TESTNET) await relayer.activate(s.accountId).catch(() => undefined);
    await open(seed, s);
  }), [open, passkeySigner, relayer, run]);

  const unlockWithPasskey = useCallback(() => run(async () => {
    const seed = await unlockPasskey();
    const s = await passkeySigner(seed);
    localStorage.setItem(PASSKEY_FLAG, s.accountId);
    await open(seed, s);
  }), [open, passkeySigner, run]);

  const signOut = useCallback(async () => {
    localStorage.removeItem(PASSKEY_FLAG);
    if (signer?.kind === "wallet") await (await connector()).disconnect().catch(() => undefined);
    setSigner(null);
    setIdentity(null);
    setWallet(null);
    setBalances(new Map());
    setStatus("signed-out");
  }, [signer]);

  const sync = useCallback(async () => {
    if (!wallet) return;
    syncRef.current ??= (async () => {
      setSyncing(true);
      try {
        await wallet.sync();
        setBalances(wallet.balances());
      } catch (e) {
        setError(`Could not sync: ${(e as Error).message}`);
      } finally {
        setSyncing(false);
        syncRef.current = null;
      }
    })();
    return syncRef.current;
  }, [wallet]);

  useEffect(() => {
    if (status !== "ready") return;
    void sync();
    const t = setInterval(() => void sync(), 20_000);
    return () => clearInterval(t);
  }, [status, sync]);

  const call = useCallback(async (c: ChainCall) => {
    if (!signer) throw new Error("Sign in first");
    return signer.call(c);
  }, [signer]);

  const transfer = useCallback(async (to: string, yocto: bigint) => {
    if (!signer) throw new Error("Sign in first");
    return signer.transfer(to, yocto);
  }, [signer]);

  const value: Session = {
    status,
    accountId: signer?.accountId ?? (status === "connected" ? localStorage.getItem(PASSKEY_FLAG) : null),
    kind: signer?.kind ?? (status === "connected" && localStorage.getItem(PASSKEY_FLAG) ? "passkey" : null),
    identity,
    wallet,
    relayer,
    error,
    balances,
    syncing,
    connectWallet,
    createPasskeyAccount,
    unlockWithPasskey,
    unlock,
    signOut,
    sync,
    canSign: signer !== null,
    call,
    transfer,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHushd(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useHushd outside HushdProvider");
  return s;
}
