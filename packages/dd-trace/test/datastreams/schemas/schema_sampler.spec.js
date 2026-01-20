'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../../setup/core')
const { SchemaSampler } = require('../../../src/datastreams/schemas/schema_sampler')

describe('SchemaSampler', () => {
  it('samples with correct weights', () => {
    const currentTimeMs = 100000
    const sampler = new SchemaSampler()

    const canSample1 = sampler.canSample(currentTimeMs)
    const weight1 = sampler.trySample(currentTimeMs)

    const canSample2 = sampler.canSample(currentTimeMs + 1000)
    const weight2 = sampler.trySample(currentTimeMs + 1000)

    const canSample3 = sampler.canSample(currentTimeMs + 2000)
    const weight3 = sampler.trySample(currentTimeMs + 2000)

    const canSample4 = sampler.canSample(currentTimeMs + 30000)
    const weight4 = sampler.trySample(currentTimeMs + 30000)

    const canSample5 = sampler.canSample(currentTimeMs + 30001)
    const weight5 = sampler.trySample(currentTimeMs + 30001)

    assert.strictEqual(canSample1, true)
    assert.strictEqual(weight1, 1)
    assert.strictEqual(canSample2, false)
    assert.strictEqual(weight2, 0)
    assert.strictEqual(canSample3, false)
    assert.strictEqual(weight3, 0)
    assert.strictEqual(canSample4, true)
    assert.strictEqual(weight4, 3)
    assert.strictEqual(canSample5, false)
    assert.strictEqual(weight5, 0)
  })
})
