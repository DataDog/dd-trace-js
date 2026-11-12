'use strict'

const assert = require('node:assert/strict')

const latestVersions = require('../../packages/dd-trace/test/plugins/versions/package.json').dependencies
const {
  getLatestPlaywrightSpecifier,
  latest,
  latestSupportedByNode18,
} = require('./versions')

describe('getLatestPlaywrightSpecifier', () => {
  it('uses the last Playwright version supporting Node.js 18', () => {
    assert.strictEqual(getLatestPlaywrightSpecifier(18), latestSupportedByNode18)
  })

  it('uses latest Playwright on supported Node.js versions', () => {
    assert.strictEqual(getLatestPlaywrightSpecifier(20), 'latest')
  })

  it('keeps Playwright packages aligned for the shared browser image', () => {
    assert.strictEqual(latestVersions.playwright, latest)
    assert.strictEqual(latestVersions['playwright-core'], latest)
  })
})
