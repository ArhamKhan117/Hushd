/**
 * One entrypoint for every Hushd service: `tsx src/main.ts <service>` or SERVICE=<service>.
 */
const service = process.argv[2] ?? process.env.SERVICE;
const services: Record<string, () => Promise<unknown>> = {
  relayer: async () => (await import("./relayer.js")).startRelayer(),
};
const start = service ? services[service] : undefined;
if (!start) {
  console.error(`usage: main.ts <${Object.keys(services).join("|")}>`);
  process.exit(2);
}
await start();
