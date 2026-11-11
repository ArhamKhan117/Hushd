# @hushd/protocol

The Hushd package protocol: typed OTC packages, quotes and receipts, exact integer math with explicit rounding, and the canonical bytes that makers and the matcher enclave sign.
It is what makes a quote signed in TypeScript verify in the Rust desk contract on NEAR and in the matcher enclave.

## Install

Node 22 or newer.

```bash
npm install @hushd/protocol
```

## Quick start

```ts
import { formatUnits, parseUnits, termsHash, termsOf } from "@hushd/protocol";

parseUnits("1250.5", 6); // 1250500000n
formatUnits(1250500000n, 6); // "1250.5"

// `quote` is a PackageQuote from a maker: the terms both sides agree on, and the hash the desk records
const terms = termsOf(quote, "spot");
const hash = termsHash(terms);
```

## What is in it

- Packages: `spot`, `spot_hedge` (a swap plus a hedge order the maker places for its own account) and `carry` (cash and carry), each with its settlement class.
- Requests, quotes, terms, consents and receipts as plain typed objects, with `bestQuote` to pick a winner.
- Canonical bytes: `termsBytes`, `termsHash`, `consentBytes`, `quoteConsent` and `hedgeHash`.
  A request can carry a 32-byte salt, so the public terms hash cannot be searched for a deal's amounts.
- Integer math: `parseUnits`, `formatUnits`, `mulDiv`, `rescale` and `bps`, each rounding the way you say.

The byte layouts are pinned by test vectors shared with the desk contract and the matcher enclave.

## Links

- Docs: https://hushd.net/docs/packages
- Source: https://github.com/ArhamKhan117/Hushd (packages/protocol)
- License: MIT
