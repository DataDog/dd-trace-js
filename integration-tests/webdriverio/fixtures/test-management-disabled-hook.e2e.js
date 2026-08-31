'use strict'

const assert = require('node:assert/strict')

describe('WebdriverIO disabled hook', () => {
  beforeEach(() => {
    assert.fail('disabled test hook ran')
  })

  it('is disabled', () => {
    assert.fail('disabled test ran')
  })
})

describe('WebdriverIO disabled hook control', () => {
  it('passes', () => {})
})
