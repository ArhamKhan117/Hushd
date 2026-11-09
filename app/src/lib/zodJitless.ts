/**
 * near-kit checks RPC answers with zod. On its first parse zod tries `new Function` to see
 * whether it may compile its parsers, and then compiles them; the Content-Security-Policy
 * (script-src has no 'unsafe-eval') reports each of those. Jitless mode parses the same
 * answers without generated code. zod reads its settings from this global, so the app sets
 * it without importing zod.
 */
const g = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
(g.__zod_globalConfig ??= {}).jitless = true;

export {};
