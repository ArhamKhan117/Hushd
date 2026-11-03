pragma circom 2.1.6;

/**
 * Hushd proof of funds, for one named reader: "I hold at least `threshold` of
 * `asset` in the pool." Up to N notes of one asset back the claim; the balance
 * and which notes back it stay private.
 *
 * Public inputs (order fixed): [root, asset, threshold, context, nullifier[0..N-1]]
 *
 * Per slot i, private: used[i], sk[i], blinding[i], amount[i], Merkle path.
 * The nullifiers are shown so the verifier can confirm on chain that no backing
 * note is spent (pool.is_spent), and that none repeats (the same note twice would
 * count twice); an empty slot shows nullifier 0. The verifier also checks `root`
 * is a root the pool knows.
 */

include "../common/note.circom";
include "../common/merkle.circom";

template Funds(nNotes, levels) {
    // public
    signal input root;
    signal input asset;
    signal input threshold;
    signal input context;
    signal input nullifier[nNotes];

    // private
    signal input used[nNotes];
    signal input sk[nNotes];
    signal input blinding[nNotes];
    signal input amount[nNotes];
    signal input pathElements[nNotes][levels];
    signal input pathIndices[nNotes][levels];

    component note[nNotes];
    component tree[nNotes];
    component range[nNotes];
    component skZero[nNotes];
    var usedCount = 0;
    var total = 0;
    for (var i = 0; i < nNotes; i++) {
        used[i] * (used[i] - 1) === 0;

        range[i] = RangeCheck();
        range[i].in <== amount[i];

        note[i] = OwnedNote();
        note[i].sk <== sk[i];
        note[i].blinding <== blinding[i];
        note[i].amount <== amount[i];
        note[i].asset <== asset;

        tree[i] = MerkleRootOf(levels);
        tree[i].leaf <== note[i].commitment;
        for (var j = 0; j < levels; j++) {
            tree[i].pathElements[j] <== pathElements[i][j];
            tree[i].pathIndices[j] <== pathIndices[i][j];
        }
        (tree[i].root - root) * used[i] === 0;

        skZero[i] = IsZero();
        skZero[i].in <== sk[i];
        skZero[i].out * used[i] === 0;

        nullifier[i] === used[i] * note[i].nullifier;
        amount[i] * (1 - used[i]) === 0;

        usedCount += used[i];
        total += amount[i];
    }

    component noneUsed = IsZero();
    noneUsed.in <== usedCount;
    noneUsed.out === 0;

    component thrRange = RangeCheck();
    thrRange.in <== threshold;
    component enough = GreaterEqThan(MAX_AMOUNT_BITS() + 2);
    enough.in[0] <== total;
    enough.in[1] <== threshold;
    enough.out === 1;

    component bindContext = Bind();
    bindContext.in <== context;
}

component main {public [root, asset, threshold, context, nullifier]} = Funds(4, 20);
