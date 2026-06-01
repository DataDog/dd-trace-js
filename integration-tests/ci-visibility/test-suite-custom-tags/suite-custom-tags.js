'use strict'

const tracer = require('dd-trace')
const assert = require('assert')

const sum = require('../test/sum')

describe('test optimization', () => {
  beforeAll(() => {
    const suiteSpan = tracer.scope().active()
    suiteSpan.setTag('suite.beforeAll', 'true')

    tracer.trace('beforeAll.setup', () => {})
  })

  afterAll(() => {
    const suiteSpan = tracer.scope().active()
    suiteSpan.setTag('suite.afterAll', 'true')

    tracer.trace('afterAll.teardown', () => {})
  })

  it('can report tests', () => {
    assert.strictEqual(sum(1, 2), 3)
  })
})
