'use strict'

const { expect } = require('chai')

describe('dynamic-instrumentation 2', () => {
  it('is not retried', () => {
    expect(1 + 2).to.equal(3)
  })
})
