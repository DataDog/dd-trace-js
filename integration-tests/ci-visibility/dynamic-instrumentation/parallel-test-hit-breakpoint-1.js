'use strict'

const sum = require('./dependency')
const { expect } = require('chai')

describe('dynamic-instrumentation', () => {
  it('retries with DI', function () {
    expect(sum(11, 3)).to.equal(14)
  })

  it('is not retried', () => {
    expect(1 + 2).to.equal(3)
  })
})
