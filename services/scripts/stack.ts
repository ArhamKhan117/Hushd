/**
 * Every Hushd service on this machine, behind one gateway that routes like the
 * production Caddyfile (deploy/Caddyfile):
 *
 *   pnpm stack                       # reads ../.env; gateway on http://localhost:8080
 *   STACK_SERVICES=api,relayer pnpm stack
 *   HUSHD_ENV_FILE=... STACK_PORT_BASE=9787 GATEWAY_PORT=9080 pnpm stack   # a second stack beside the first
 *
 * Services without their keys in .env exit with a message; the rest keep running.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";

const dotenv = process.env.HUSHD_ENV_FILE ?? new URL("../../.env", import.meta.url).pathname;
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

const BASE = Number(process.env.STACK_PORT_BASE ?? 8787);
const PORTS: Record<string, number> = Object.fromEntries(["relayer", "api", "indexer", "matcher", "makers", "keeper", "topup", "market"].map((s, i) => [s, BASE + i]));
const wanted = (process.env.STACK_SERVICES ?? "api,relayer,indexer,matcher,makers,keeper,topup,market").split(",").map((s) => s.trim()).filter((s) => s in PORTS);
const children: ChildProcess[] = [];

for (const name of wanted) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", name], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORTS[name]) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = `${name.padEnd(8)}|`;
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.on("data", (b: Buffer) => process.stdout.write(b.toString().split("\n").filter(Boolean).map((l) => `${tag} ${l}\n`).join("")));
  }
  child.on("exit", (code) => process.stdout.write(`${tag} exited (${code})\n`));
  children.push(child);
}

/** The same routes as deploy/Caddyfile. */
function target(path: string): number {
  if (path.startsWith("/v1/relay/")) return PORTS.relayer!;
  if (path.startsWith("/makers/")) return PORTS.makers!;
  const health = /^\/health\/([a-z]+)$/.exec(path);
  if (health && PORTS[health[1]!]) return PORTS[health[1]!]!;
  return PORTS.api!;
}

const gatewayPort = Number(process.env.GATEWAY_PORT ?? 8080);
http
  .createServer((req, res) => {
    const url = req.url ?? "/";
    const port = target(url.split("?")[0]!);
    const path = /^\/health\/[a-z]+$/.test(url) ? "/health" : url;
    const upstream = http.request({ host: "127.0.0.1", port, path, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `service on :${port} is not running` }));
    });
    req.pipe(upstream);
  })
  .listen(gatewayPort, () => process.stdout.write(`gateway | http://localhost:${gatewayPort} -> ${wanted.join(", ")}\n`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const c of children) c.kill(sig);
    process.exit(0);
  });
}
