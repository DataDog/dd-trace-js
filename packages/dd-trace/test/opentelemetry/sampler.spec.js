'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha

require('../setup/tap')

const Sampler = require('../../src/opentelemetry/sampler')

describe('OTel Sampler', () => {
  it('should sample', () => {
    const sampler = new Sampler()

    expect(sampler.shouldSample()).to.eql({
      decision: 2
    })
  })

  it('should stringify', () => {
    const sampler = new Sampler()
    expect(sampler.toString()).to.eq('DatadogSampler')
  })
})
