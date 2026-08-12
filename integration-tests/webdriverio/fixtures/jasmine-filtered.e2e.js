'use strict'

const assert = require('node:assert/strict')

describe('WebdriverIO Jasmine filtering', () => {
  it('runs selected test', () => {})

  it('stays filtered', () => {
    assert.fail('filtered test ran')
  })
})
