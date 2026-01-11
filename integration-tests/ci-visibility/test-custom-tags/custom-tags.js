'use strict'

const tracer = require('dd-trace')
const assert = require('assert')

const sum = require('../test/sum')
describe('test optimization custom tags', () => {
  beforeEach(() => {
    const testSpan = tracer.scope().active()
    testSpan.setTag('custom_tag.beforeEach', 'true')
  })

  it('can report tests', () => {
    const testSpan = tracer.scope().active()
    testSpan.setTag('custom_tag.it', 'true')
    assert.strictEqual(sum(1, 2), 3)
  })

  afterEach(() => {
    const testSpan = tracer.scope().active()
    testSpan.setTag('custom_tag.afterEach', 'true')
  })
})
