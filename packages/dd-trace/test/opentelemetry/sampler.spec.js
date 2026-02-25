'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')
const Sampler = require('../../src/opentelemetry/sampler')

describe('OTel Sampler', () => {
  it('should sample', () => {
    const sampler = new Sampler()

    assert.deepStrictEqual(sampler.shouldSample(), {
      decision: 2,
    })
  })

  it('should stringify', () => {
    const sampler = new Sampler()
    assert.strictEqual(sampler.toString(), 'DatadogSampler')
  })
})
