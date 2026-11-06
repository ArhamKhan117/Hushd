/**
 * One entrypoint for every Hushd service: `tsx src/main.ts <service>` or SERVICE=<service>.
 */
import { existsSync } from "node:fs";

// Outside Docker, read the repo's .env (values already in the environment win).
const dotenv = new URL("../../.env", import.meta.url).pathname;
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

const service = process.argv[2] ?? process.env.SERVICE;
const services: Record<string, () => Promise<unknown>> = {
  relayer: async () => (await import("./relayer.js")).startRelayer(),
  api: async () => (await import("./api.js")).startApi(),
  indexer: async () => (await import("./indexer.js")).startIndexer(),
  matcher: async () => (await import("./matcher.js")).startMatcher(),
  makers: async () => (await import("./makers.js")).startMakers(),
  keeper: async () => (await import("./keeper.js")).startKeeper(),
  topup: async () => (await import("./topup.js")).startTopUp(),
  market: async () => (await import("./market-agent.js")).startMarketAgent(),
};
const start = service ? services[service] : undefined;
if (!start) {
  console.error(`usage: main.ts <${Object.keys(services).join("|")}>`);
  process.exit(2);
}
await start();
