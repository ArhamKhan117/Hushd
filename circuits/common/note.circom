pragma circom 2.1.6;

/**
 * Hushd note scheme (Poseidon over BN254, circomlib parameters).
 *
 *   pk         = Poseidon(sk)                    receive key
 *   inner      = Poseidon(pk, blinding)          hides the owner; a deposit publishes only this
 *   commitment = Poseidon(inner, amount, asset)  the leaf the pool inserts
 *   nullifier  = Poseidon(sk, commitment)        marks the note spent
 *
 * The pool computes `commitment` itself from a deposit's `inner` and the tokens it
 * actually received, so a deposit can never claim more than it sends. A note made
 * for someone else uses their pk, and only the holder of the matching sk can spend it.
 *
 * Must match packages/sdk/src/note.ts and contracts/pool/src/poseidon.rs.
 */

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

// Every amount is below 2^128: far above any token supply, far below the field
// (about 2^254), so sums of a few notes can never wrap.
function MAX_AMOUNT_BITS() { return 128; }

template ReceiveKey() {
    signal input sk;
    signal output pk;
    component h = Poseidon(1);
    h.inputs[0] <== sk;
    pk <== h.out;
}

template NoteCommitment() {
    signal input pk;
    signal input blinding;
    signal input amount;
    signal input asset;
    signal output inner;
    signal output commitment;

    component hi = Poseidon(2);
    hi.inputs[0] <== pk;
    hi.inputs[1] <== blinding;
    inner <== hi.out;

    component hc = Poseidon(3);
    hc.inputs[0] <== inner;
    hc.inputs[1] <== amount;
    hc.inputs[2] <== asset;
    commitment <== hc.out;
}

template Nullifier() {
    signal input sk;
    signal input commitment;
    signal output out;
    component h = Poseidon(2);
    h.inputs[0] <== sk;
    h.inputs[1] <== commitment;
    out <== h.out;
}

// A spendable note opened from its secrets: the receive key, the commitment and its nullifier.
template OwnedNote() {
    signal input sk;
    signal input blinding;
    signal input amount;
    signal input asset;
    signal output commitment;
    signal output nullifier;

    component key = ReceiveKey();
    key.sk <== sk;

    component note = NoteCommitment();
    note.pk <== key.pk;
    note.blinding <== blinding;
    note.amount <== amount;
    note.asset <== asset;
    commitment <== note.commitment;

    component n = Nullifier();
    n.sk <== sk;
    n.commitment <== note.commitment;
    nullifier <== n.out;
}

template RangeCheck() {
    signal input in;
    component bits = Num2Bits(MAX_AMOUNT_BITS());
    bits.in <== in;
}

template NonZero() {
    signal input in;
    component z = IsZero();
    z.in <== in;
    z.out === 0;
}

// A public input that only binds data (context, extHash): one square so the
// compiler keeps it as a real constraint on the proof.
template Bind() {
    signal input in;
    signal sq;
    sq <== in * in;
}
