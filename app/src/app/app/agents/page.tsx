import { x402Network } from "@hushd/sdk";
import type { Metadata } from "next";
import deployment from "../../../../../deployments/testnet.json";
import { AppShell } from "@/components/app/AppShell";
import { PolicyWallets, type WalletLabel } from "@/components/app/PolicyWallets";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { IS_TESTNET, NETWORK } from "@/lib/hushd/config";

export const metadata: Metadata = { title: "Agents" };

/**
 * Hushd's own policy wallets, named from the deployment record (read on the server; only
 * the names reach the page). There is a record for testnet only, so other networks show none.
 */
const record = IS_TESTNET ? (deployment as { deployer: string; policyWallets?: Record<string, { account: string; owner: string }> }) : null;
const OWNER = record?.deployer ?? null;
const LABELS: WalletLabel[] = Object.entries(record?.policyWallets ?? {})
  .filter(([, w]) => w.owner === OWNER)
  .map(([prefix, w]) => ({
    account: w.account,
    label: prefix === "DEMO_AGENT" ? "Demo agent" : /^MAKER_[A-Z]$/.test(prefix) ? `Maker ${prefix.slice(-1)}` : prefix.charAt(0) + prefix.slice(1).toLowerCase().replace(/_/g, " "),
  }));

const LOCAL = `# from a checkout of this repo
pnpm install
pnpm mcp init        # writes a new agent seed to ~/.hushd/seed (mode 600)

# Claude Code: the agent's own wallet, inside its limits
claude mcp add hushd \\
  -e HUSHD_LIMIT_PER_PAYMENT="USDC=100,wNEAR=50" \\
  -e HUSHD_LIMIT_PER_DAY="USDC=500,wNEAR=250" \\
  -- pnpm --silent --dir "$PWD" mcp`;

const HOSTED = `# read-only: status, makers, deals, proof checks
claude mcp add --transport http hushd-read https://hushd.net/mcp`;

const USDC = NETWORK.tokens.find((t) => t.symbol === "USDC")?.id ?? NETWORK.tokens[0]!.id;
const BTC = NETWORK.tokens.find((t) => t.symbol === "BTC")?.id ?? NETWORK.tokens.at(-1)!.id;
const X402 = `curl -i "${NETWORK.api.replace(/\/$/, "")}/makers/steady/quote?sell=${USDC}&amount=1000000000&buy=${BTC}"
# HTTP/1.1 402 Payment Required
# {"x402Version":1,"accepts":[{"scheme":"hushd","network":"${x402Network(NETWORK)}",
#   "maxAmountRequired":"10000","asset":"${USDC}","payTo":"hushd1…", …}]}`;

const TOOLS: [string, string][] = [
  ["hushd_address, hushd_balance", "The agent's receive address and private balance"],
  IS_TESTNET ? ["hushd_faucet, hushd_shield", "Testnet tokens to its NEAR account, then into the pool"] : ["hushd_shield", "Tokens from its NEAR account into the pool"],
  ["hushd_send, hushd_cash_out", "Pay a hushd1… address, or out to a NEAR account"],
  ["hushd_pay_link, hushd_claim_link", "Pay anyone as a claim link, or claim one (hushd_my_links, hushd_take_back_link)"],
  ["hushd_trade", "Ask the desk's makers, match in the enclave, settle privately"],
  ["hushd_pay_x402", "Pay a 402 resource from the private balance"],
  ["hushd_prove, hushd_my_payments", "A payment, funds or volume proof for one named reader"],
  ["hushd_limits, hushd_my_deals", "What it may spend and what it traded"],
  ["hushd_status, hushd_makers, hushd_desk_deals, hushd_deal, hushd_verify_proof", "Read tools, also on the hosted server"],
];

export default function AgentsPage() {
  return (
    <AppShell title="Agents" subtitle="Give an agent a private balance and a seat at the desk. It pays, trades and proves through MCP, and never spends past the limits you set.">
      <div className="grid max-w-[760px] gap-8">
        <section className="grid gap-3">
          <p className="t-label">Run it with the agent&apos;s own seed</p>
          <p className="text-[14.5px] leading-relaxed text-soft">
            The MCP server runs next to the agent. It proves every payment in its own process, so the seed never leaves the machine. Each token needs a limit per payment and per day; a token with no limit cannot be spent.
          </p>
          <CodeBlock code={LOCAL} lang="bash" title="Local MCP server" />
        </section>

        <section className="grid gap-3">
          <p className="t-label">Or connect to the hosted, read-only server</p>
          <CodeBlock code={HOSTED} lang="bash" title="Hosted MCP" />
        </section>

        <PolicyWallets owner={OWNER} labels={LABELS} />

        <section className="grid gap-3">
          <p className="t-label">Tools</p>
          <ul className="hd-card divide-y divide-line">
            {TOOLS.map(([names, what]) => (
              <li key={names} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-4 sm:px-5">
                <span className="break-words font-mono text-[12.5px] text-foreground">{names}</span>
                <span className="text-[13.5px] text-soft">{what}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="grid gap-3">
          <p className="t-label">Private x402</p>
          <p className="text-[14.5px] leading-relaxed text-soft">
            The makers sell indicative quotes over HTTP 402. The price is paid as a private note to the maker&apos;s hushd1… address; the request carries the note&apos;s opening sealed to the maker, who checks that the pool created exactly that note. The chain shows a pool transaction, not who paid whom or how much. <code className="text-foreground">hushd_pay_x402</code> does all of this inside the agent&apos;s limits.
          </p>
          <CodeBlock code={X402} lang="bash" title="A 402 answer" />
        </section>

        <section className="grid gap-2">
          <p className="t-label">For coding agents</p>
          <p className="text-[14.5px] leading-relaxed text-soft">
            The repo carries an agent skill at <code className="text-foreground">skills/hushd/SKILL.md</code>, an <code className="text-foreground">AGENTS.md</code>, and{" "}
            <a href="/llms.txt" className="text-foreground underline decoration-line-strong underline-offset-4">
              llms.txt
            </a>{" "}
            for the whole site.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
