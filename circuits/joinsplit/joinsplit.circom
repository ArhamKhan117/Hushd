pragma circom 2.1.6;

/**
 * Hushd joinsplit: spend up to two notes into two new ones, optionally paying
 * `publicAmount` of `publicAsset` out of the pool. One circuit covers a private
 * send (publicAmount = 0), a cash out with change, and each leg of an atomic swap.
 *
 * Public inputs (order fixed, must match contracts/pool and packages/sdk):
 *   [root, nullifier[0], nullifier[1], commitment[0], commitment[1],
 *    publicAmount, publicAsset, extHash]
 *
 * - An input with amount 0 is a dummy: its Merkle path is not checked, so a single
 *   note can be spent alone. Its nullifier is still published and consumed.
 * - Every input and output shares one private `asset`; a cash out reveals it
 *   (publicAsset must equal it whenever publicAmount is not 0).
 * - Conservation: sum(in) = sum(out) + publicAmount, every amount below 2^128.
 * - extHash binds everything a relayer could otherwise change (recipient, fee,
 *   refund note, deal id and the other swap leg's outputs). The pool recomputes it.
 *
 * The pool checks outside the circuit: root is a known root, the two nullifiers
 * differ and are unspent, and publicAsset is 0 when publicAmount is 0.
 */

include "../common/note.circom";
include "../common/merkle.circom";

template JoinSplit(levels, nIn, nOut) {
    // public
    signal input root;
    signal input nullifier[nIn];
    signal input commitment[nOut];
    signal input publicAmount;
    signal input publicAsset;
    signal input extHash;

    // private
    signal input asset;
    signal input inSk[nIn];
    signal input inBlinding[nIn];
    signal input inAmount[nIn];
    signal input pathElements[nIn][levels];
    signal input pathIndices[nIn][levels];
    signal input outPk[nOut];
    signal input outBlinding[nOut];
    signal input outAmount[nOut];

    component inNote[nIn];
    component inRange[nIn];
    component inSkNonZero[nIn];
    component inTree[nIn];
    component inIsDummy[nIn];
    var sumIn = 0;
    for (var i = 0; i < nIn; i++) {
        inSkNonZero[i] = NonZero();
        inSkNonZero[i].in <== inSk[i];

        inNote[i] = OwnedNote();
        inNote[i].sk <== inSk[i];
        inNote[i].blinding <== inBlinding[i];
        inNote[i].amount <== inAmount[i];
        inNote[i].asset <== asset;
        nullifier[i] === inNote[i].nullifier;

        inRange[i] = RangeCheck();
        inRange[i].in <== inAmount[i];

        inTree[i] = MerkleRootOf(levels);
        inTree[i].leaf <== inNote[i].commitment;
        for (var j = 0; j < levels; j++) {
            inTree[i].pathElements[j] <== pathElements[i][j];
            inTree[i].pathIndices[j] <== pathIndices[i][j];
        }
        // A real input (amount > 0) must sit under the public root.
        inIsDummy[i] = IsZero();
        inIsDummy[i].in <== inAmount[i];
        (inTree[i].root - root) * (1 - inIsDummy[i].out) === 0;

        sumIn += inAmount[i];
    }

    component outNote[nOut];
    component outRange[nOut];
    var sumOut = 0;
    for (var k = 0; k < nOut; k++) {
        outNote[k] = NoteCommitment();
        outNote[k].pk <== outPk[k];
        outNote[k].blinding <== outBlinding[k];
        outNote[k].amount <== outAmount[k];
        outNote[k].asset <== asset;
        commitment[k] === outNote[k].commitment;

        outRange[k] = RangeCheck();
        outRange[k].in <== outAmount[k];
        sumOut += outAmount[k];
    }

    component publicRange = RangeCheck();
    publicRange.in <== publicAmount;
    sumIn === sumOut + publicAmount;

    // A cash out names the asset it pays.
    publicAmount * (asset - publicAsset) === 0;

    component bindExt = Bind();
    bindExt.in <== extHash;
}

component main {public [root, nullifier, commitment, publicAmount, publicAsset, extHash]} = JoinSplit(20, 2, 2);
