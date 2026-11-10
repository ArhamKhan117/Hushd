/**
 * The NEAR AI Cloud side of plain-language intake. The browser encrypts the deal to
 * the attested model's key (packages/sdk/src/intake.ts); this proxy only adds the API
 * key, so it never sees the text. Around that it uses @nearai/inference-sdk to:
 *   1. fetch and verify the model's attestation (Intel TDX quote and NVIDIA GPU
 *      evidence) before handing its signing key to the browser, and
 *   2. verify each response: the TEE's signature over the exact request and response
 *      bytes, checked against that verified attestation.
 * Only models marked verifiable (running inside a NEAR AI TEE) are allowed.
 */
import type { Hono } from "hono";
import { settings } from "./config.js";
import { BadRequest } from "./http.js";

const NEARAI = () => settings.str("NEARAI_URL", "https://cloud-api.near.ai/v1").replace(/\/$/, "");
const MODEL = () => settings.str("NEARAI_MODEL", "z-ai/glm-5.3-flash");
const KEY = () => settings.str("NEARAI_API_KEY", "");

type Sdk = typeof import("@nearai/inference-sdk");
type Verified = Awaited<ReturnType<Sdk["verifyModelAttestation"]>>;

let cached: { at: number; model: string; verified: Verified } | null = null;

async function sdk(): Promise<Sdk> {
  return import("@nearai/inference-sdk");
}

/** Attestation reads are public; completions and their signatures need the API key. */
async function client(withKey: boolean) {
  const { AttestationClient } = await sdk();
  if (withKey && !KEY()) throw new BadRequest("Intake is off: NEARAI_API_KEY is not set on this API");
  return new AttestationClient({ baseUrl: NEARAI(), ...(KEY() ? { apiKey: KEY() } : {}) });
}

/** The model's attestation, verified, cached for ten minutes. */
async function attestation(): Promise<Verified> {
  if (cached && cached.model === MODEL() && Date.now() - cached.at < 600_000) return cached.verified;
  const s = await sdk();
  const c = await client(false);
  const meta = (await c.fetchModelMetadata(MODEL())) as { attestationSupported?: boolean };
  if (!meta.attestationSupported) throw new BadRequest(`${MODEL()} does not run in a TEE; intake only uses verifiable models`);
  const fetched = await c.fetchModelAttestations({ model: MODEL(), signingAlgo: "ed25519" });
  const first = fetched.attestations[0];
  if (!first) throw new Error("No attestation for the model");
  const verified = await s.verifyModelAttestation({ attestation: first, clientBinding: fetched.clientBinding });
  cached = { at: Date.now(), model: MODEL(), verified };
  return verified;
}

export function intakeRoutes(a: Hono) {
  a.get("/v1/intake/attestation", async (c) => {
    // NEAR AI Cloud down, or a quote that does not check out: the intake is off, and the answer says why
    let v: Awaited<ReturnType<typeof attestation>>;
    try {
      v = await attestation();
      if (!v.signingPublicKey) throw new Error("The attestation carries no encryption key");
    } catch (e) {
      return c.json({ model: MODEL(), enabled: false, unavailable: (e as Error).message });
    }
    return c.json({
      model: MODEL(),
      signing_public_key: v.signingPublicKey,
      signing_address: v.signer.signingAddress,
      tcb_status: v.tcbStatus,
      gpu_evidence: v.gpuEvidence,
      verified_at_ms: cached?.at ?? Date.now(),
      enabled: Boolean(KEY()),
      verify_url: "https://cloud.near.ai/verify",
    });
  });

  a.post("/v1/intake/chat", async (c) => {
    const b = await c.req.json<{ body: string; clientPub: string; modelPub: string }>();
    if (typeof b.body !== "string" || b.body.length > 20_000) throw new BadRequest("body");
    if (!/^[0-9a-f]{64}$/.test(b.clientPub ?? "") || !/^[0-9a-f]{64}$/.test(b.modelPub ?? "")) throw new BadRequest("keys are 32-byte hex");
    let req: { model?: string; messages?: { content?: unknown }[]; stream?: boolean };
    try {
      req = JSON.parse(b.body);
    } catch {
      throw new BadRequest("body is JSON");
    }
    if (req.model !== MODEL() || req.stream) throw new BadRequest("Only the configured model, without streaming");
    if (!req.messages?.length || !req.messages.every((m) => typeof m.content === "string" && /^[0-9a-f]+$/.test(m.content))) throw new BadRequest("Every message must be encrypted (hex)");
    const ac = await client(true);
    const v = await attestation();
    if (v.signingPublicKey?.toLowerCase() !== b.modelPub.toLowerCase()) throw new BadRequest("Encrypted to a key that is not the verified model's");

    const res = await fetch(`${NEARAI()}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY()}`,
        "content-type": "application/json",
        "x-signing-algo": "ed25519",
        "x-client-pub-key": b.clientPub,
        "x-model-pub-key": b.modelPub,
        "x-encryption-version": "2",
      },
      body: b.body,
      signal: AbortSignal.timeout(90_000),
    });
    const responseText = await res.text();
    if (!res.ok) {
      cached = null;
      return c.json({ error: `NEAR AI answered ${res.status}: ${responseText.slice(0, 200)}` }, 502);
    }
    const id = (JSON.parse(responseText) as { id: string }).id;

    let signature: Awaited<ReturnType<typeof ac.fetchCompletionSignature>> | null = null;
    for (let i = 0; i < 6 && !signature; i++) {
      signature = await ac.fetchCompletionSignature({ completionId: id, signingAlgo: "ed25519" }).catch(() => null);
      if (!signature) await new Promise((r) => setTimeout(r, 700));
    }
    if (!signature) return c.json({ error: "The response signature is not available" }, 502);
    const s = await sdk();
    let serverVerified = false;
    try {
      s.verifyModelResponse({ requestBody: new TextEncoder().encode(b.body), responseBody: new TextEncoder().encode(responseText), signature, attestation: v });
      serverVerified = true;
    } catch {
      serverVerified = false;
    }
    return c.json({
      response: responseText,
      serverVerified,
      signature: { text: signature.signedText, signature: signature.signature, signing_address: signature.signer.signingAddress, signature_kind: signature.kind },
    });
  });
}
