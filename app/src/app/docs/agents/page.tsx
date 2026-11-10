import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout, Code } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "Agents and MCP",
  description:
    "The Hushd MCP server: run it next to an agent with its own seed and spending limits (HUSHD_LIMIT_PER_PAYMENT, HUSHD_LIMIT_PER_DAY), or connect to the hosted read-only server at hushd.net/mcp. Every tool explained.",
  alternates: { canonical: "/docs/agents" },
};

const TOOLS: [string, string, string][] = [
  ["hushd_status", "Read", "The pool and the desk: listed tokens and deposit limits, pool counts, desk counts"],
  ["hushd_makers", "Read", "Makers taking requests now: name, pricing style, bond, deals and slashed amount (paused accounts with include_inactive)"],
  ["hushd_desk_deals", "Read", "Recent deals as the chain sees them: class, maker, state and receipt"],
  ["hushd_deal", "Read", "One deal's public record and receipt"],
  ["hushd_verify_proof", "Read", "Check a hushdproof1… string, as a named reader if given"],
  ["hushd_address", "Wallet", "The agent's hushd1… receive address"],
  ["hushd_balance", "Wallet", "Sync, then the private balance per token"],
  ["hushd_limits", "Wallet", "Its limits per payment and per day, and what it spent today"],
  ["hushd_policy", "Wallet", "Its NEAR account: a policy wallet's owner, TEE rules and frozen state, or its own key"],
  ["hushd_faucet", "Wallet", "Testnet tokens to the agent's NEAR account"],
  ["hushd_shield", "Wallet", "Move tokens from its NEAR account into its private balance"],
  ["hushd_send", "Wallet, limited", "Pay a hushd1… address privately"],
  ["hushd_pay_link", "Wallet, limited", "Pay anyone as a claim link: whoever opens it first claims it, with no gas"],
  ["hushd_claim_link", "Wallet", "Claim a link into its own private balance (its own link: a take back)"],
  ["hushd_my_links", "Wallet", "Links it paid, read from the pool: waiting, claimed or taken back"],
  ["hushd_take_back_link", "Wallet", "Take back a link it paid that nobody claimed"],
  ["hushd_cash_out", "Wallet, limited", "Pay out to a NEAR account"],
  ["hushd_trade", "Wallet, limited", "Ask the desk, match in the enclave, settle privately"],
  ["hushd_my_deals", "Wallet", "Deals it took part in, with the terms only it can read"],
  ["hushd_my_payments", "Wallet", "Payments it made, newest first, numbered for hushd_prove"],
  ["hushd_prove", "Wallet", "A payment, funds or volume proof for one named reader"],
  ["hushd_pay_x402", "Wallet, limited", "Fetch a URL and pay its private 402, inside the limits"],
];

const ENV: [string, string][] = [
  ["HUSHD_SEED", "The agent's seed, 64 hex. Without it, the file `pnpm mcp init` wrote"],
  ["HUSHD_HOME", "Where the seed, notes and spending ledger live (default ~/.hushd)"],
  ["HUSHD_LIMIT_PER_PAYMENT", "Caps per payment, per token, e.g. USDC=100,wNEAR=50"],
  ["HUSHD_LIMIT_PER_DAY", "Caps per UTC day, per token, e.g. USDC=500,wNEAR=250"],
  ["HUSHD_POLICY_WALLET_KEY", "Its OutLayer policy wallet's key (wk_…): the NEAR account for hushd_faucet and hushd_shield, signed in a TEE"],
  ["HUSHD_LIMITS_EXPIRE", "A date after which the agent may not spend at all, e.g. 2026-12-01"],
  ["HUSHD_ALLOW_TO", "The only hushd1… addresses and NEAR accounts it may send, cash out or pay over x402 to, comma separated"],
  ["HUSHD_NEAR_ACCOUNT", "Or a NEAR testnet account with its own key, for hushd_faucet and hushd_shield"],
  ["HUSHD_NEAR_PRIVATE_KEY", "That account's key (ed25519:…)"],
  ["HUSHD_NETWORK", "testnet; mainnet once Hushd's contracts are deployed there (or with HUSHD_RPC_URL, a local node running them)"],
  ["HUSHD_API_URL", "A self-hosted Hushd API (default https://api.hushd.net)"],
  ["HUSHD_RPC_URL", "NEAR RPC endpoints, comma separated"],
  ["HUSHD_CIRCUITS_DIR", "Proving artifacts on disk (found on its own inside the repo)"],
  ["HUSHD_CIRCUITS_URL", "Or where to fetch them (default https://hushd.net/circuits)"],
  ["HUSHD_VERIFY_URL", "The checker proof links point to (default https://hushd.net/verify)"],
  ["HUSHD_APP_URL", "The app claim links open in, as <origin>/app/claim#… (default https://hushd.net)"],
];

export default function AgentsDocsPage() {
  return (
    <DocsLayout
      title="Agents and MCP"
      lede="Give an agent a private balance and a seat at the desk. It pays, trades and proves through MCP, and never spends past the limits you set."
      glance={[
        { label: "Local", value: "Own seed, all tools" },
        { label: "Hosted", value: "hushd.net/mcp, read-only" },
        { label: "Transport", value: "stdio, Streamable HTTP" },
      ]}
    >
      <h2 id="two-ways-to-connect">Two ways to connect</h2>
      <ul>
        <li>
          <strong>Locally, with the agent&apos;s own seed.</strong> The server runs next to the agent, over stdio. It
          holds the agent&apos;s keys, proves every payment in its own process, and refuses anything over its limits.
          This is how an agent pays, trades and proves.
        </li>
        <li>
          <strong>Hosted, read-only.</strong> <code>https://hushd.net/mcp</code> speaks Streamable HTTP and runs only
          the read tools. It holds no keys and cannot move anything.
        </li>
      </ul>

      <h2 id="local-server">Run it locally</h2>
      <p>From a checkout of the repo:</p>
      <pre>
        <code className="language-bash">{`pnpm install
pnpm mcp init   # writes a new agent seed to ~/.hushd/seed (mode 600)

# Claude Code: the agent's own wallet, inside its limits
claude mcp add hushd \\
  -e HUSHD_LIMIT_PER_PAYMENT="USDC=100,wNEAR=50" \\
  -e HUSHD_LIMIT_PER_DAY="USDC=500,wNEAR=250" \\
  -- pnpm --silent --dir "$PWD" mcp`}</code>
      </pre>
      <p>Any other MCP client takes the same command:</p>
      <pre>
        <code className="language-json">{`{
  "mcpServers": {
    "hushd": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/hushd", "mcp"],
      "env": {
        "HUSHD_LIMIT_PER_PAYMENT": "USDC=100,wNEAR=50",
        "HUSHD_LIMIT_PER_DAY": "USDC=500,wNEAR=250"
      }
    }
  }
}`}</code>
      </pre>
      <p>
        The server is the <code>@hushd/mcp</code> package in the repo (<code>packages/mcp</code>), which is not
        published on npm, so it runs from a checkout of the repo. With no seed it starts anyway
        and serves the read tools only. To fund the agent, give it a <a href="#policy-wallets">policy wallet</a> (or a NEAR
        account with its own key) and use <code>hushd_faucet</code> then <code>hushd_shield</code>, or pay its{" "}
        <code>hushd1</code> address from your own private balance.
      </p>

      <h2 id="hosted-server">The hosted, read-only server</h2>
      <pre>
        <code className="language-bash">{`claude mcp add --transport http hushd-read https://hushd.net/mcp`}</code>
      </pre>
      <p>
        In a client that takes a URL, add <code>https://hushd.net/mcp</code> as a Streamable HTTP server. It is
        stateless and answers the five read tools below, against NEAR testnet.
      </p>

      <h2 id="tools">Tools</h2>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          {TOOLS.map(([name, kind, what]) => (
            <tr key={name}>
              <td>
                <Code>{name}</Code>
                <span className="mt-1 block text-[13px] text-mute">{kind}</span>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <code>hushd_trade</code> takes the package kind, what to sell and how much, what to buy, a{" "}
        <code>min_receive</code> above zero (the least it accepts, sealed to the enclave) and a quote window of 10 to
        300 seconds. It returns the deal,
        the maker and what was given and received. <code>hushd_prove</code> takes a reader and a validity of 1 to 90
        days, and returns the proof with a link to check it.
      </p>
      <p>
        To pay a counterparty who is not on Hushd yet, <code>hushd_pay_link</code> takes a token and an amount and
        returns a claim link (<code>https://hushd.net/app/claim#…</code>). Hand it over privately: whoever opens it
        claims the payment into their own private balance with a passkey or a NEAR wallet, and needs no gas. If nobody
        claims it, <code>hushd_take_back_link</code> returns the amount. An agent paid with a link claims it with{" "}
        <code>hushd_claim_link</code>.
      </p>

      <h2 id="spending-limits">Spending limits</h2>
      <p>
        Every token the agent may spend needs two caps, in the token&apos;s own units: one per payment and one per UTC
        day. A token with no limit set cannot be spent at all.
      </p>
      <pre>
        <code className="language-bash">{`HUSHD_LIMIT_PER_PAYMENT="USDC=100,wNEAR=50,BTC=0.002"   # the default
HUSHD_LIMIT_PER_DAY="USDC=500,wNEAR=250,BTC=0.01"       # the default`}</code>
      </pre>
      <ul>
        <li>
          <code>hushd_send</code>, <code>hushd_pay_link</code>, <code>hushd_cash_out</code> and{" "}
          <code>hushd_trade</code> (for the amount sold) check both caps before anything is proved, and record what was
          spent once it is.
        </li>
        <li>
          Anyone holding a link can claim it, so an agent with a payee list (<code>HUSHD_ALLOW_TO</code>) may not pay
          as a link at all.
        </li>
        <li>
          <code>hushd_pay_x402</code> pays a 402 only up to the smaller of the per-payment cap and what is left of
          today&apos;s; a higher price is refused, not paid. Like a send, it stops at the end date, and with a payee
          list it pays only a 402 whose hushd1… address is on it.
        </li>
        <li>
          <code>hushd_trade</code> needs <code>min_receive</code>, the least the agent accepts, above zero. Anyone can
          register as a maker, so the floor is what keeps a fill fair.
        </li>
        <li>
          What was spent today is kept in a file under <code>HUSHD_HOME</code>, so restarting the server does not reset
          the day.
        </li>
        <li>
          <code>hushd_limits</code> lets the agent read its own limits, so it can plan inside them.
        </li>
      </ul>
      <Callout title="Limits live with the server, not the model">
        The model asks; the server decides. A prompt cannot raise a limit, since the limits are read from the
        server&apos;s environment when it starts.
      </Callout>
      <p>
        These limits are the only guard on the private balance, and they run in the MCP process beside the agent. The
        relayer sends whatever was proved and knows nothing of them. The seed sits on the same machine, so anything that
        can read it, an agent with shell or file access included, can spend the whole balance without asking the
        server. Keep in the balance only what you would let the agent lose.
      </p>

      <h2 id="policy-wallets">Policy wallets</h2>
      <p>
        An agent does not need a NEAR key. Its NEAR account can be an OutLayer policy wallet: the key is made and kept
        inside OutLayer&apos;s TEE, the agent holds only an API key, and the enclave checks the owner&apos;s policy
        before it signs anything. The owner stores the policy on chain from their own account (on{" "}
        <code>outlayer.testnet</code>), which makes them its only controller, and can freeze the wallet with one
        transaction. The desk&apos;s three makers and the demo agent work this way.
      </p>
      <pre>
        <code className="language-bash">{`# the owner: a wallet, its policy stored from the owner's account, funded for gas
pnpm --filter @hushd/services policy-wallet create MY_AGENT --per-tx 0.02 --daily 0.2 --per-hour 60
# the agent: only the wallet's key
claude mcp add hushd -e HUSHD_POLICY_WALLET_KEY=wk_… -e HUSHD_LIMIT_PER_DAY="USDC=500" -- pnpm --silent --dir "$PWD" mcp
# the owner, at any time
pnpm --filter @hushd/services policy-wallet freeze MY_AGENT`}</code>
      </pre>
      <p>The Agents page in the app does the same from a NEAR wallet or a passkey.</p>
      <table>
        <thead>
          <tr>
            <th>Rule</th>
            <th>Who enforces it</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Contract calls only, to Hushd&apos;s contracts only</td>
            <td>The TEE, before it signs</td>
          </tr>
          <tr>
            <td>NEAR attached per call and per day, calls per hour, hours of the day</td>
            <td>The TEE, before it signs</td>
          </tr>
          <tr>
            <td>Freeze</td>
            <td>The TEE reads it on chain for every signature; this server also stops every private payment while it is set</td>
          </tr>
          <tr>
            <td>Token amounts per payment and per day, expiry, payees</td>
            <td>This server, before it proves or pays (the TEE does not read call arguments)</td>
          </tr>
        </tbody>
      </table>

      <h2 id="environment">Environment</h2>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>What it sets</th>
          </tr>
        </thead>
        <tbody>
          {ENV.map(([k, v]) => (
            <tr key={k}>
              <td>
                <Code>{k}</Code>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 id="what-stays-on-the-machine">What stays on the agent&apos;s machine</h2>
      <ul>
        <li>The seed, which spends the agent&apos;s private balance. Keep it secret.</li>
        <li>
          Its notes, in a file encrypted with AES-256-GCM under a key from the seed, so the file alone reveals nothing.
        </li>
        <li>Every proof, made in the server&apos;s own process. The model sees results, never keys or notes.</li>
      </ul>
      <p>
        Every note the agent makes for itself is also posted to the board, encrypted to it, so the seed alone recovers
        its balance on another machine.
      </p>

      <h2 id="for-coding-agents">For coding agents</h2>
      <p>
        The repo carries an <code>AGENTS.md</code> and an agent skill at <code>skills/hushd/SKILL.md</code>, and the
        site has <a href="/llms.txt">llms.txt</a>. Agents that pay for HTTP resources should also read{" "}
        <Link href="/docs/x402">private x402</Link>.
      </p>
    </DocsLayout>
  );
}
