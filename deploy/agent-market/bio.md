# Hushd price check

Before a large trade, know what the market would really give you.

Send one line, such as "sell 2,500 USDC for NEAR" or "buy BTC with 1,000 USDC".
You get back, within a minute or two:

- the live NEAR Intents (1Click) quote for exactly that trade, routed across 39 chains;
- the Hyperliquid mid price, as a fair value;
- how far each quote sits from the mid, in basis points;
- for USDC, NEAR and BTC, the indicative quotes of Hushd's three bonded makers on NEAR testnet.

This agent pays each Hushd maker for its quote over private x402: the payment is a note in Hushd's shielded pool, so nobody can see who asked or how much.

Hushd is a private OTC desk on NEAR where automated maker agents quote sealed requests: requests are sealed to an enclave, both legs settle in one private call, and a trader can prove one fact about a deal to one named reader.
Try it at https://hushd.net.

Prices are indicative and change by the second; this is information, not advice.
