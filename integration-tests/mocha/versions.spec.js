'use strict'

const assert = require('node:assert/strict')

const {
  getLatestMochaSpecifier,
  latestBeforeMocha11,
  latestBeforeMocha12,
} = require('./versions')

describe('getLatestMochaSpecifier', () => {
  it('uses Mocha 10 when Mocha 11 does not support the Node.js runtime', () => {
    assert.strictEqual(getLatestMochaSpecifier('18.17.1'), latestBeforeMocha11)
    assert.strictEqual(getLatestMochaSpecifier('20.8.1'), latestBeforeMocha11)
    assert.strictEqual(getLatestMochaSpecifier('21.0.0'), latestBeforeMocha11)
  })

  it('uses Mocha 11 when Mocha 12 does not support the Node.js runtime', () => {
    assert.strictEqual(getLatestMochaSpecifier('18.18.0'), latestBeforeMocha12)
    assert.strictEqual(getLatestMochaSpecifier('18.20.8'), latestBeforeMocha12)
    assert.strictEqual(getLatestMochaSpecifier('20.9.0'), latestBeforeMocha12)
    assert.strictEqual(getLatestMochaSpecifier('20.18.1'), latestBeforeMocha12)
    assert.strictEqual(getLatestMochaSpecifier('21.1.0'), latestBeforeMocha12)
    assert.strictEqual(getLatestMochaSpecifier('22.11.0'), latestBeforeMocha12)
  })

  it('uses latest Mocha on supported Node.js versions', () => {
    assert.strictEqual(getLatestMochaSpecifier('20.19.0'), 'latest')
    assert.strictEqual(getLatestMochaSpecifier('22.12.0'), 'latest')
  })
})
