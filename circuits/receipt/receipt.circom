pragma circom 2.1.6;

/**
 * Hushd proof of payment or settlement, for one named reader.
 *
 * "I made note `commitment` for receive key P, worth at least `minAmount` of
 * `asset`, and I paid for it with the note whose nullifier is `nullifier`."
 *
 * The second opening is what ties the payment to the prover: only whoever held the
 * spent note knows its sk, so a note the prover merely received cannot be claimed as
 * one they made. The verifier checks on chain that the pool spent `nullifier` in the
 * same call that inserted `commitment` (pool.spend_of), which also names the deal
 * when the payment was a leg of an OTC settlement.
 *
 * Public inputs (order fixed):
 *   [commitment, nullifier, asset, minAmount, reveal, shownAmount, showPayee, shownPayee, context]
 *
 * - reveal = 1 shows the exact amount (shownAmount = amount), 0 hides it (shownAmount = 0).
 * - showPayee = 1 shows the payee's receive key (shownPayee = pk), 0 hides it.
 * - context binds the reader's NEAR account, the expiry, the network and the pool.
 */

include "../common/note.circom";

template Receipt() {
    // public
    signal input commitment;
    signal input nullifier;
    signal input asset;
    signal input minAmount;
    signal input reveal;
    signal input shownAmount;
    signal input showPayee;
    signal input shownPayee;
    signal input context;

    // private: the note that was made
    signal input payeePk;
    signal input blinding;
    signal input amount;
    // private: the note that paid for it
    signal input inSk;
    signal input inBlinding;
    signal input inAmount;

    component made = NoteCommitment();
    made.pk <== payeePk;
    made.blinding <== blinding;
    made.amount <== amount;
    made.asset <== asset;
    commitment === made.commitment;

    component paid = OwnedNote();
    paid.sk <== inSk;
    paid.blinding <== inBlinding;
    paid.amount <== inAmount;
    paid.asset <== asset;
    nullifier === paid.nullifier;

    component skNonZero = NonZero();
    skNonZero.in <== inSk;
    component amountNonZero = NonZero();
    amountNonZero.in <== amount;

    component amtRange = RangeCheck();
    amtRange.in <== amount;
    component minRange = RangeCheck();
    minRange.in <== minAmount;
    component enough = GreaterEqThan(MAX_AMOUNT_BITS() + 1);
    enough.in[0] <== amount;
    enough.in[1] <== minAmount;
    enough.out === 1;

    reveal * (reveal - 1) === 0;
    shownAmount === reveal * amount;
    showPayee * (showPayee - 1) === 0;
    shownPayee === showPayee * payeePk;

    component bindContext = Bind();
    bindContext.in <== context;
}

component main {public [commitment, nullifier, asset, minAmount, reveal, shownAmount, showPayee, shownPayee, context]} = Receipt();
