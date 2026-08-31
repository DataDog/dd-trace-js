'use strict'

const assert = require('node:assert/strict')

describe('WebdriverIO ATR', () => {
  it('fails every retry', () => {
    assert.fail('ATR failure')
  })
})
