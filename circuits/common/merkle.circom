pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

/**
 * Poseidon Merkle tree, depth `levels`: parent = Poseidon(left, right);
 * pathIndices[i] = 0 when the running node is the left child.
 * Must match contracts/pool/src/tree.rs.
 */

template HashLeftRight() {
    signal input left;
    signal input right;
    signal output hash;
    component h = Poseidon(2);
    h.inputs[0] <== left;
    h.inputs[1] <== right;
    hash <== h.out;
}

// s = 0: out = [in[0], in[1]]; s = 1: out = [in[1], in[0]]. Also forces s to be a bit.
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];
    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

// The root a leaf hashes up to, so callers can gate the root check on a flag.
template MerkleRootOf(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component selectors[levels];
    component hashers[levels];
    signal hashes[levels + 1];
    hashes[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        selectors[i] = DualMux();
        selectors[i].in[0] <== hashes[i];
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];
        hashers[i] = HashLeftRight();
        hashers[i].left <== selectors[i].out[0];
        hashers[i].right <== selectors[i].out[1];
        hashes[i + 1] <== hashers[i].hash;
    }
    root <== hashes[levels];
}
