/*
 * Node's `assert` for the browser build (next.config.ts points `assert` here).
 * circomlibjs checks Poseidon's inputs with `assert(cond)`. Next's own stand-in brings
 * a copy of Node's `util` that builds a function from a string while it loads, which
 * the Content-Security-Policy refuses (script-src has no 'unsafe-eval').
 */
"use strict";

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
  }
}

function fail(message) {
  throw message instanceof Error ? message : new AssertionError(message === undefined ? "Failed" : String(message));
}

function ok(value, message) {
  if (!value) fail(message === undefined ? "The expression evaluated to a falsy value" : message);
}

module.exports = ok;
module.exports.ok = ok;
module.exports.fail = fail;
module.exports.AssertionError = AssertionError;
module.exports.equal = (a, b, message) => ok(a == b, message === undefined ? `${a} == ${b}` : message);
module.exports.notEqual = (a, b, message) => ok(a != b, message === undefined ? `${a} != ${b}` : message);
module.exports.strictEqual = (a, b, message) => ok(Object.is(a, b), message === undefined ? `${a} === ${b}` : message);
module.exports.notStrictEqual = (a, b, message) => ok(!Object.is(a, b), message === undefined ? `${a} !== ${b}` : message);
