'use strict'

const t = require('tap')
require('../setup/core')

const { expect } = require('chai')

const Sampler = require('../../src/opentelemetry/sampler')

t.test('OTel Sampler', t => {
  t.test('should sample', t => {
    const sampler = new Sampler()

    expect(sampler.shouldSample()).to.eql({
      decision: 2
    })
    t.end()
  })

  t.test('should stringify', t => {
    const sampler = new Sampler()
    expect(sampler.toString()).to.eq('DatadogSampler')
    t.end()
  })
  t.end()
})
