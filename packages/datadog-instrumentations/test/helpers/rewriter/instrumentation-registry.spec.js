'use strict'

const assert = require('node:assert/strict')

const {
  isRewriteActivationEnabled,
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
        assert.strictEqual(isRewriteActivationEnabled(module.name), true)
      }
    }
  })

  it('does not activate rewrite targets without the opt-in flag', () => {
    for (const { activate, instrumentations: entryInstrumentations } of registry) {
      if (activate) continue

      for (const { module } of entryInstrumentations) {
        assert.strictEqual(isRewriteActivationEnabled(module.name), false)
      }
    }
  })

  it('returns false for unknown module names', () => {
    assert.strictEqual(isRewriteActivationEnabled('not-a-registered-module'), false)
  })
})
