'use strict'

const assert = require('node:assert/strict')

describe('custom test environment', () => {
  it('runs with a custom environment and reports tests', () => {
    assert.strictEqual(global.__DD_CUSTOM_JEST_ENVIRONMENT__, true)
    assert.strictEqual(
      global.__DD_CUSTOM_JEST_ENVIRONMENT_TEST_STARTED__,
      'runs with a custom environment and reports tests'
    )
  })
})
