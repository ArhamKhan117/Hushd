import type { Metadata } from "next";
import Link from "next/link";
import { accountUrl, TESTNET } from "@hushd/sdk";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout, Code } from "@/components/docs/FlowDiagram";
import { NETWORK } from "@/lib/hushd/config";

export const metadata: Metadata = {
  title: "Contracts",
  description:
    "Hushd's contracts on NEAR testnet: pool.hushd.testnet, desk.hushd.testnet, board.hushd.testnet and the test tokens usdc, wnear and btc.hushd.testnet. What each one does, its methods and its NEP-297 events.",
  alternates: { canonical: "/docs/contracts" },
};

const ACCOUNTS: { account: string; what: string }[] = [
  ...(NETWORK.pool ? [{ account: NETWORK.pool, what: "The shielded pool: notes, proofs, settlement" }] : []),
  ...(NETWORK.desk ? [{ account: NETWORK.desk, what: "The desk: makers, bonds, requests, deals, receipts" }] : []),
  ...(NETWORK.board ? [{ account: NETWORK.board, what: "The board: sealed word of payments" }] : []),
  ...NETWORK.tokens.map((t) => ({ account: t.id, what: `Test ${t.symbol}, ${t.decimals} decimals, with a faucet` })),
];

const EXTERNAL: { account: string; what: string }[] = [
  { account: TESTNET.mpc, what: "NEAR Chain Signatures: signs each deal's hedge order" },
  { account: TESTNET.outlayer, what: "OutLayer: runs the matcher in a TEE and resumes the desk's call" },
];

function AccountLink({ account }: { account: string }) {
  return (
    <a href={accountUrl(NETWORK, account)} target="_blank" rel="noreferrer">
      <Code>{account}</Code>
    </a>
  );
}

export default function ContractsPage() {
  return (
    <DocsLayout
      title="Contracts"
      lede="Every Hushd contract runs on NEAR testnet, written in Rust with near-sdk. Here is each account, what it does, and how to check it."
      glance={[
        { label: "Network", value: "NEAR testnet" },
        { label: "Events", value: "NEP-297, standard hushd" },
        { label: "Explorer", value: "NearBlocks" },
      ]}
    >
      <h2 id="accounts">Accounts</h2>
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>What it is</th>
          </tr>
        </thead>
        <tbody>
          {ACCOUNTS.map((a) => (
            <tr key={a.account}>
              <td>
                <AccountLink account={a.account} />
              </td>
              <td>{a.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>The desk also calls two accounts Hushd does not run:</p>
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>What it is</th>
          </tr>
        </thead>
        <tbody>
          {EXTERNAL.map((a) => (
            <tr key={a.account}>
              <td>
                <AccountLink account={a.account} />
              </td>
              <td>{a.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        These come from <code>packages/sdk/src/network.ts</code>. The live state of each one is on{" "}
        <Link href="/transparency">transparency</Link>.
      </p>

      <h2 id="pool">Pool</h2>
      <p>
        A shielded pool for NEP-141 tokens. Notes are Poseidon commitments in a Merkle tree of depth 20, and the pool
        keeps the last 100 roots, so a proof made a few blocks ago still lands. Every Groth16 proof is verified inside
        the call with NEAR&apos;s <code>alt_bn128</code> host functions.
      </p>
      <ul>
        <li>
          <strong>Add</strong>: <code>ft_transfer_call</code> from the token to the pool with{" "}
          <code>{`{"inner": "<field>"}`}</code>. The pool computes the note from what it actually received, so a
          deposit needs no proof and cannot claim more than it sends.
        </li>
        <li>
          <strong>
            <code>transact</code>
          </strong>
          : spend up to two notes into two new ones, optionally cashing out with change. One proof. If the payout
          fails, a refund note goes back into the pool.
        </li>
        <li>
          <strong>
            <code>settle_swap</code>
          </strong>
          : two counterparties&apos; legs in one call, only from the desk, for a deal it matched.
        </li>
        <li>
          <strong>
            <code>verify_disclosure</code>
          </strong>{" "}
          (view): checks a proof made for one named reader against chain state.
        </li>
        <li>
          <strong>Rules</strong>: listing a token, its deposit limits, the desk and the owner change only through{" "}
          <code>propose_change</code> and a timelock; anyone can <code>apply_change</code> after it. The owner can pause
          new deposits, never cash outs. There is no admin withdraw.
        </li>
      </ul>
      <p>
        Views: <code>get_root</code>, <code>is_known_root</code>, <code>next_leaf_index</code>, <code>leaves</code>,{" "}
        <code>is_spent</code>, <code>spend_of</code>, <code>assets</code>, <code>stats</code>, <code>config</code>.
      </p>

      <h2 id="desk">Desk</h2>
      <ul>
        <li>
          <strong>Makers</strong>: <code>register_maker</code>, bonds posted with <code>ft_transfer_call</code> and the
          message <code>bond</code>, <code>withdraw_bond</code>, <code>set_maker_active</code>.
        </li>
        <li>
          <strong>Requests</strong>: <code>open_rfq</code> stores the sha256 of a sealed request and its quote window.
        </li>
        <li>
          <strong>Matches</strong>: <code>request_match</code> and its OutLayer callback, or <code>submit_match</code>{" "}
          with the enclave&apos;s signature. Either way the desk checks the maker&apos;s quote key signed the terms.
        </li>
        <li>
          <strong>Settlement</strong>: <code>settle</code> forwards both legs to <code>pool.settle_swap</code>;{" "}
          <code>expire</code> closes a deal nobody settled.
        </li>
        <li>
          <strong>Hedges</strong>: <code>sign_hedge_order</code> and <code>close_hedge</code> through Chain Signatures,{" "}
          <code>record_hedge</code> from the keeper, <code>slash_overdue</code> for anyone after the deadline.
        </li>
      </ul>
      <p>
        Views: <code>config</code>, <code>enclave</code>, <code>makers</code>, <code>maker</code>, <code>rfq</code>,{" "}
        <code>deal</code>, <code>deals</code> (newest first), <code>stats</code>, <code>hedge_path</code>.
      </p>

      <h2 id="board">Board</h2>
      <p>
        Where a payer leaves word of a payment for its recipient: <code>post</code> stores a ciphertext of up to 2048
        bytes, paid for from the poster&apos;s NEP-145 storage balance. The board never records who posted, and posts
        cannot be deleted. Views: <code>count</code> and <code>posts</code>, a hundred at a time.
      </p>

      <h2 id="test-tokens">Test tokens</h2>
      <p>
        Standard NEP-141 tokens with NEP-145 storage and NEP-148 metadata, plus a faucet: <code>faucet</code> for
        yourself, or <code>faucet_for</code> another account, a fixed amount per account per cooldown. The faucet
        registers the receiver&apos;s storage itself. These tokens exist only on testnet and have no value.
      </p>

      <h2 id="events">Events</h2>
      <p>
        Every contract logs NEP-297 events with standard <code>hushd</code>, version <code>1.0.0</code>. The indexer
        reads them from FastNEAR&apos;s neardata block stream.
      </p>
      <table>
        <thead>
          <tr>
            <th>Contract</th>
            <th>Events</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Pool</td>
            <td>
              <code>shield</code>, <code>shield_refused</code>, <code>transact</code>, <code>swap</code>,{" "}
              <code>payout</code>, <code>rule_change</code>, <code>deposits_paused</code>
            </td>
          </tr>
          <tr>
            <td>Desk</td>
            <td>
              <code>maker_registered</code>, <code>bond_posted</code>, <code>bond_withdrawn</code>,{" "}
              <code>rfq_opened</code>, <code>deal_matched</code>, <code>spot_settled</code>, <code>hedge_signed</code>,{" "}
              <code>bond_slashed</code>, <code>receipt</code>, <code>enclave_key</code>
            </td>
          </tr>
          <tr>
            <td>Board</td>
            <td>
              <code>post</code>, <code>max_post_bytes</code>
            </td>
          </tr>
        </tbody>
      </table>

      <h2 id="check-them-yourself">Check them yourself</h2>
      <ul>
        <li>Open each account on NearBlocks from the table above: its code hash, transactions and logs.</li>
        <li>
          Build the contracts from <code>contracts/</code> in the repo and compare. The verifying keys in the pool are
          generated from the same files the browser proves with.
        </li>
        <li>
          Read any view directly with NEAR RPC, or with <code>poolView</code> and <code>deskView</code> from the{" "}
          <Link href="/docs/sdk#reads">SDK</Link>.
        </li>
      </ul>
      <Callout title="Not on mainnet">
        No Hushd contract is deployed on NEAR mainnet. Any account claiming to be one is not ours.
      </Callout>
    </DocsLayout>
  );
}
