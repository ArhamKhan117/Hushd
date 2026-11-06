/**
 * Direct trades between two agents on NEAR Intents: each agent is an implicit account with
 * its own key, deposits into the verifier, signs its side of the trade as a `token_diff`,
 * and one of them submits both with `execute_intents`. The pair is simulated first, so a
 * trade that would not balance (or a stale signature) never costs gas.
 *
 * The same code runs on mainnet (`intents.near`) and on a local sandbox with the verifier
 * deployed (scripts/intents-sandbox.ts).
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { Near } from "near-kit";
import { type CallSpec, type HushdNetwork, type Intent, type MultiPayload, accountBalance, implicitAccount, keepRpcErrorBodies, sendEndpoints, signIntents, tradeDiffs, verifierCalls, verifierView, view } from "@hushd/sdk";

export interface Leg {
  token: string;
  amount: bigint;
}

/** One agent: an implicit account, its key, and the verifier it trades on. */
export class IntentsAgent {
  readonly accountId: string;
  readonly client: Near;
  constructor(
    readonly net: HushdNetwork,
    readonly verifier: string,
    private readonly secret: Uint8Array,
    readonly label: string,
  ) {
    this.accountId = implicitAccount(secret);
    const pub = ed25519.getPublicKey(secret);
    keepRpcErrorBodies(net.rpc);
    this.client = new Near({
      network: { networkId: net.id, rpcUrl: sendEndpoints(net)[0]! },
      privateKey: `ed25519:${base58.encode(new Uint8Array([...secret, ...pub]))}`,
      defaultSignerId: this.accountId,
      defaultWaitUntil: "FINAL",
    });
  }

  /** Send one call from this agent; returns the transaction hash. */
  async send(c: CallSpec): Promise<string> {
    const r = await this.client
      .transaction(this.accountId)
      .functionCall(c.receiver, c.method, c.args, { gas: `${Number(c.gas)}`, attachedDeposit: c.deposit })
      .send();
    const failure = (r.status as { Failure?: unknown })?.Failure ?? r.receipts_outcome?.map((o) => (o.outcome.status as { Failure?: unknown }).Failure).find(Boolean);
    if (failure) throw new Error(`${this.label}: ${c.receiver}.${c.method} failed: ${JSON.stringify(failure).slice(0, 300)}`);
    return r.transaction.hash;
  }

  /** Send NEAR (creates an implicit account on its first transfer). */
  async transfer(to: string, yocto: bigint): Promise<string> {
    return (await this.client.transaction(this.accountId).transfer(to, yocto).send()).transaction.hash;
  }

  async nearBalance(): Promise<bigint | null> {
    return accountBalance(this.net, this.accountId);
  }

  /** Registered on a token (to hold or receive it); registers when not. */
  async ensureRegistered(token: string, account = this.accountId): Promise<string | null> {
    const have = await view<unknown>(this.net, token, "storage_balance_of", { account_id: account });
    return have ? null : this.send(verifierCalls.storageDeposit(token, account));
  }

  async tokenBalance(token: string): Promise<bigint> {
    return BigInt(await view<string>(this.net, token, "ft_balance_of", { account_id: this.accountId }));
  }

  /** Move tokens from this account into the verifier. */
  deposit(token: string, amount: bigint): Promise<string> {
    return this.send(verifierCalls.deposit(this.verifier, token, amount));
  }

  balances(tokens: string[]): Promise<Record<string, bigint>> {
    return verifierView.balances(this.net, this.verifier, this.accountId, tokens);
  }

  /** Sign intents with this agent's key against the verifier's current salt. */
  async sign(intents: Intent[], deadlineMs: number): Promise<MultiPayload> {
    const salt = await verifierView.salt(this.net, this.verifier);
    return signIntents({ signerId: this.accountId, secret: this.secret, verifier: this.verifier, salt, deadlineMs, intents });
  }

  /** Signed withdrawals of these amounts from the verifier back to `receiver` (registered on each token beforehand). */
  withdrawals(legs: Leg[], receiver: string, deadlineMs: number): Promise<MultiPayload> {
    return this.sign(
      legs.filter((l) => l.amount > 0n).map((l) => ({ intent: "ft_withdraw", token: l.token, receiver_id: receiver, amount: l.amount.toString() })),
      deadlineMs,
    );
  }
}

/** Simulate signed intents, refuse anything that would not balance, then have `submitter` execute them. */
export async function executeSigned(submitter: IntentsAgent, signed: MultiPayload[]): Promise<{ txHash: string; executed: number }> {
  const sim = await verifierView.simulate(submitter.net, submitter.verifier, signed);
  if (sim.invariant_violated) throw new Error(`the verifier would refuse this: ${sim.invariant_violated.error} ${JSON.stringify(sim.invariant_violated.unmatched_deltas ?? {})}`);
  const txHash = await submitter.send(verifierCalls.execute(submitter.verifier, signed));
  return { txHash, executed: sim.intents_executed.length };
}

/** The two signed sides of a trade where `a` gives `give` and receives `take` from `b`, net of the verifier's fee. */
export async function signTrade(a: IntentsAgent, b: IntentsAgent, give: Leg, take: Leg, deadlineMs: number): Promise<{ a: MultiPayload; b: MultiPayload; diffs: ReturnType<typeof tradeDiffs> }> {
  const feePips = await verifierView.fee(a.net, a.verifier);
  const diffs = tradeDiffs({ give, take, feePips });
  const [sa, sb] = await Promise.all([a.sign([{ intent: "token_diff", diff: diffs.a }], deadlineMs), b.sign([{ intent: "token_diff", diff: diffs.b }], deadlineMs)]);
  return { a: sa, b: sb, diffs };
}
