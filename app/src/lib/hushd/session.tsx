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
  loadPoseidon,
  PrivateWallet,
  RelayerClient,
  SEED_MESSAGE,
  seedFromSignature,
  type Identity,
  type NoteStore,
  type WalletState,
} from "@hushd/sdk";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CIRCUITS_BASE, NETWORK } from "./config";
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
    ({ NearConnector }) => new NearConnector({ network: NETWORK.id, features: { signMessage: true, testnet: true } }),
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
    const near = new Near({ network: { networkId: NETWORK.id, rpcUrl: NETWORK.rpc[0]! }, privateKey: k.secretKey as `ed25519:${string}`, defaultSignerId: k.implicitAccount });
    return {
      accountId: k.implicitAccount,
      kind: "passkey",
      async call(x) {
        try {
          const out = (await near
            .transaction(k.implicitAccount)
            .functionCall(x.contract, x.method, x.args, { gas: `${Number(BigInt(x.gas ?? "100000000000000") / 1_000_000_000_000n)} Tgas` as `${number} Tgas`, attachedDeposit: BigInt(x.deposit ?? "0") })
            .send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as unknown as { transaction?: { hash?: string } };
          return { txHash: out?.transaction?.hash ?? "" };
        } catch (e) {
          throw new Error(readableChainError(e));
        }
      },
      async transfer(to, yocto) {
        try {
          const out = (await near.transaction(k.implicitAccount).transfer(to, yocto).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as unknown as { transaction?: { hash?: string } };
          return { txHash: out?.transaction?.hash ?? "" };
        } catch (e) {
          throw new Error(readableChainError(e));
        }
      },
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
    // The relayer opens the implicit account with a little testnet NEAR for gas.
    await relayer.activate(s.accountId).catch(() => undefined);
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
