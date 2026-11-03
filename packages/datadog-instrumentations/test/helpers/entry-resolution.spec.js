'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const vm = require('node:vm')

const { describe, it } = require('mocha')

const indexPath = require.resolve('../../index.js')
const indexDir = path.dirname(indexPath)

/**
 * Resolves a relative request the way Vite does by default, trying `.mjs` before `.js`.
 *
 * @param {string} request
 */
function resolvePreferringMjs (request) {
  const base = path.resolve(indexDir, request)
  const candidates = [base, `${base}.mjs`, `${base}.js`, path.join(base, 'index.mjs'), path.join(base, 'index.js')]
  return candidates.find(candidate => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile())
}

describe('datadog-instrumentations entry point', () => {
  it('requires files that resolve the same when a bundler prefers .mjs over .js', () => {
    /** @type {string[]} */
    const requests = []
    const wrapped = vm.runInThisContext(Module.wrap(fs.readFileSync(indexPath, 'utf8')), { filename: indexPath })
    wrapped({}, (/** @type {string} */ request) => { requests.push(request) }, { exports: {} }, indexPath, indexDir)

    assert.notStrictEqual(requests.length, 0)
    const nodeRequire = Module.createRequire(indexPath)
    for (const request of requests) {
      assert.strictEqual(resolvePreferringMjs(request), nodeRequire.resolve(request), request)
    }
  })
})
