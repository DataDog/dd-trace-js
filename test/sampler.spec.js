'use strict'

describe('Sampler', () => {
  let Sampler
  let sampler

  beforeEach(() => {
    Sampler = require('../src/sampler')
    sampler = new Sampler()
  })

  it('should always sample', () => {
    expect(sampler.isSampled()).to.be.true
  })
})
