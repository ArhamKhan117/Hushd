/** Byte encodings that work the same in Node and the browser (no Buffer). */
import { base64, base64urlnopad, hex as hexCodec } from "@scure/base";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const toB64 = (b: Uint8Array) => base64.encode(b);
export const fromB64 = (s: string) => base64.decode(s);
export const utf8ToB64 = (s: string) => base64.encode(enc.encode(s));
export const utf8ToB64url = (s: string) => base64urlnopad.encode(enc.encode(s));
export const b64urlToUtf8 = (s: string) => dec.decode(base64urlnopad.decode(s));
export const hexToBytes = (h: string) => hexCodec.decode(h.replace(/^0x/, "").toLowerCase());
export const bytesToHex = (b: Uint8Array) => `0x${hexCodec.encode(b)}`;
