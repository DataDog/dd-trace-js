'use strict'

const assert = require('node:assert/strict')

const suiteName = process.env.WEBDRIVERIO_FRAMEWORK === 'jasmine'
  ? 'WebdriverIO ATR always fails'
  : 'WebdriverIO ATR'

describe(suiteName, () => {
  it('fails every retry', () => {
    assert.fail('ATR failure')
  })
})
