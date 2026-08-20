'use strict'

const assert = require('node:assert/strict')

const {
  getLatestPlaywrightSpecifier,
  latestSupportedByNode18,
} = require('./versions')

describe('getLatestPlaywrightSpecifier', () => {
  it('uses the last Playwright version supporting Node.js 18', () => {
    assert.strictEqual(getLatestPlaywrightSpecifier(18), latestSupportedByNode18)
  })

  it('uses latest Playwright on supported Node.js versions', () => {
    assert.strictEqual(getLatestPlaywrightSpecifier(20), 'latest')
  })
})
