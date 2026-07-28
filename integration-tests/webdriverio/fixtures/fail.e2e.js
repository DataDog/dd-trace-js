'use strict'

const assert = require('node:assert/strict')

describe('WebdriverIO failing worker', () => {
  it('fails before the next grouped spec', () => {
    assert.fail('expected WebdriverIO integration failure')
  })
})
