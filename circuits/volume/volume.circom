pragma circom 2.1.6;

/**
 * Hushd OTC volume, for one named reader: "across these `count` settlement legs I
 * delivered exactly `total` of `asset`, and I made every one of them."
 *
 * Each leg is a note the prover made for a counterparty, paid for by a note the
 * prover spent (as in receipt.circom). Up to N legs per proof, used slots first.
 *
 * Public inputs (order fixed): [asset, total, count, legsHash, context]
 *
 *   legsHash = h_N with h_0 = 0 and h_{i+1} = Poseidon(h_i, commitment[i], nullifier[i])
 *   over all N slots (empty slots hash in as 0, 0).
 *
 * The plain (commitment, nullifier) list travels with the proof. The verifier
 * rehashes it to legsHash, checks the pairs are distinct, and checks on chain that
 * the pool spent each nullifier in the call that inserted its commitment, as part
 * of a desk deal (pool.spend_of names the deal).
 */

include "../common/note.circom";

template Volume(nSlots) {
    // public
    signal input asset;
    signal input total;
    signal input count;
    signal input legsHash;
    signal input context;

    // private
    signal input used[nSlots];
    signal input payeePk[nSlots];
    signal input blinding[nSlots];
    signal input amount[nSlots];
    signal input commitment[nSlots];
    signal input inSk[nSlots];
    signal input inBlinding[nSlots];
    signal input inAmount[nSlots];
    signal input nullifier[nSlots];

    component made[nSlots];
    component paid[nSlots];
    component range[nSlots];
    component amtZero[nSlots];
    component skZero[nSlots];
    component chain[nSlots];
    signal acc[nSlots + 1];
    acc[0] <== 0;
    var usedCount = 0;
    var sum = 0;
    for (var i = 0; i < nSlots; i++) {
        used[i] * (used[i] - 1) === 0;
        if (i > 0) {
            used[i] * (1 - used[i - 1]) === 0;
        }

        range[i] = RangeCheck();
        range[i].in <== amount[i];
        amtZero[i] = IsZero();
        amtZero[i].in <== amount[i];
        amtZero[i].out * used[i] === 0;
        amount[i] * (1 - used[i]) === 0;

        made[i] = NoteCommitment();
        made[i].pk <== payeePk[i];
        made[i].blinding <== blinding[i];
        made[i].amount <== amount[i];
        made[i].asset <== asset;
        commitment[i] === used[i] * made[i].commitment;

        paid[i] = OwnedNote();
        paid[i].sk <== inSk[i];
        paid[i].blinding <== inBlinding[i];
        paid[i].amount <== inAmount[i];
        paid[i].asset <== asset;
        nullifier[i] === used[i] * paid[i].nullifier;

        skZero[i] = IsZero();
        skZero[i].in <== inSk[i];
        skZero[i].out * used[i] === 0;

        chain[i] = Poseidon(3);
        chain[i].inputs[0] <== acc[i];
        chain[i].inputs[1] <== commitment[i];
        chain[i].inputs[2] <== nullifier[i];
        acc[i + 1] <== chain[i].out;

        usedCount += used[i];
        sum += amount[i];
    }

    total === sum;
    count === usedCount;
    component noneUsed = IsZero();
    noneUsed.in <== count;
    noneUsed.out === 0;
    legsHash === acc[nSlots];

    component bindContext = Bind();
    bindContext.in <== context;
}

component main {public [asset, total, count, legsHash, context]} = Volume(16);
