'use strict'

const assert = require('node:assert/strict')

const {
  getRewriteActivationName,
  instrumentations,
  registry,
} = require('../../../src/helpers/rewriter/instrumentation-registry')

describe('instrumentation registry', () => {
  it('exposes every registry instrumentation as a rewrite target', () => {
    assert.deepStrictEqual(instrumentations, registry.flatMap(entry => entry.instrumentations))
  })

  it('uses the module name to activate opted-in rewrite targets', () => {
    for (const { activate, instrumentations: entryInstrumentations } of registry) {
      if (!activate) continue

      for (const { module } of entryInstrumentations) {
        assert.strictEqual(getRewriteActivationName(module.name), module.name)
      }
    }
  })

  it('does not activate rewrite targets without the opt-in flag', () => {
    for (const { activate, instrumentations: entryInstrumentations } of registry) {
      if (activate) continue

      for (const { module } of entryInstrumentations) {
        assert.strictEqual(getRewriteActivationName(module.name), undefined)
      }
    }
  })

  it('returns undefined for unknown module names', () => {
    assert.strictEqual(getRewriteActivationName('not-a-registered-module'), undefined)
  })
})
