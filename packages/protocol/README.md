# @hushd/protocol

The Hushd package protocol: typed OTC packages (spot, spot with a hedge leg, cash and carry), package quotes and receipts, exact integer math with explicit rounding, and the canonical bytes that makers and the matcher enclave sign.

```ts
import { parseUnits, formatUnits } from "@hushd/protocol";
```

The same bytes are checked by the desk contract on NEAR testnet and by the matcher enclave, so a quote signed here verifies there.
Source: https://github.com/ArhamKhan117/hushd.
