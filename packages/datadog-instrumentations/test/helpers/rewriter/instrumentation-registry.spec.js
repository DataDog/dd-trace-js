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

  it('maps module names of entries with an activation name to that name', () => {
    for (const { activationName, instrumentations: entryInstrumentations } of registry) {
      if (!activationName) continue

      for (const { module } of entryInstrumentations) {
        assert.strictEqual(getRewriteActivationName(module.name), activationName)
      }
    }
  })

  it('does not map modules of entries without an activation name', () => {
    for (const { activationName, instrumentations: entryInstrumentations } of registry) {
      if (activationName) continue

      for (const { module } of entryInstrumentations) {
        assert.strictEqual(getRewriteActivationName(module.name), undefined)
      }
    }
  })

  it('returns undefined for unknown module names', () => {
    assert.strictEqual(getRewriteActivationName('not-a-registered-module'), undefined)
  })
})
