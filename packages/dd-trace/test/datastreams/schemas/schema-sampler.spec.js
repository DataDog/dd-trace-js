'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha

require('../../setup/core')

const { SchemaSampler } = require('../../../src/datastreams/schemas/schema-sampler')

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

    expect(canSample1).to.be.true
    expect(weight1).to.equal(1)
    expect(canSample2).to.be.false
    expect(weight2).to.equal(0)
    expect(canSample3).to.be.false
    expect(weight3).to.equal(0)
    expect(canSample4).to.be.true
    expect(weight4).to.equal(3)
    expect(canSample5).to.be.false
    expect(weight5).to.equal(0)
  })
})
