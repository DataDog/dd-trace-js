'use strict'

require('tap')
const { describe, it, before, beforeEach, after, afterEach } = require('@tapjs/mocha-globals')
globalThis.describe = describe
globalThis.it = it
globalThis.before = patchHook(before)
globalThis.after = patchHook(after)
globalThis.beforeEach = patchHook(beforeEach)
globalThis.afterEach = patchHook(afterEach)
require('./core')

function promisify(fn) {
  return () => new Promise(done => fn(done))
}

function patchHook(hook) {
  return function patchedHook(fn) {
    return hook(fn.length ? promisify(fn) : fn)
  }
}
