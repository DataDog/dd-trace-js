'use strict'

const { expect } = require('chai')
const sum = require('../test/sum')
const tracer = require('dd-trace')

describe('test optimization custom tags', () => {
  beforeEach(() => {
    const testSpan = tracer.scope().active()
    testSpan.setTag('custom_tag.beforeEach', 'true')
  })

  it('can report tests', () => {
    const testSpan = tracer.scope().active()
    testSpan.setTag('custom_tag.it', 'true')
    expect(sum(1, 2)).to.equal(3)
  })

  afterEach(() => {
    const testSpan = tracer.scope().active()
    testSpan.setTag('custom_tag.afterEach', 'true')
  })
})
