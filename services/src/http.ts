/** Shared HTTP plumbing: health endpoints, JSON errors, a small per-client rate limiter. */
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

export function app(service: string, health: () => Promise<Record<string, unknown>> = async () => ({})) {
  const started = Date.now();
  const a = new Hono();
  a.use("*", cors());
  /** Liveness: the process answers. */
  a.get("/live", (c) => c.json({ service, live: true }));
  /** Health: the process can do its job (dependencies reachable). */
  a.get("/health", async (c) => {
    try {
      const extra = await health();
      return c.json({ service, ok: true, uptimeS: Math.round((Date.now() - started) / 1000), ...extra });
    } catch (e) {
      return c.json({ service, ok: false, error: (e as Error).message }, 503);
    }
  });
  a.onError((e, c) => {
    const client = (e as { status?: number }).status === 400;
    // a refused request is the caller's business; anything else is ours, so log it
    if (!client) console.error(`${service} ${c.req.method} ${c.req.path}: ${e.message}`);
    return c.json({ error: e.message }, client ? 400 : 500);
  });
  return a;
}

export class BadRequest extends Error {
  readonly status = 400;
}

export function listen(a: Hono, port: number, name: string) {
  serve({ fetch: a.fetch, port });
  console.log(`${name} listening on :${port}`);
}

/** Token bucket per client key (IP): `perMinute` requests, bursting to the same. */
export function rateLimit(perMinute: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return async (c: Context, next: () => Promise<void>) => {
    const key = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (b.tokens < 1) return c.json({ error: "Too many requests; try again in a minute" }, 429);
    b.tokens -= 1;
    buckets.set(key, b);
    await next();
  };
}
