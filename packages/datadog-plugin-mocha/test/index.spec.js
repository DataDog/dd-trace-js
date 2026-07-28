'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')

const MochaPlugin = require('../src')

describe('MochaPlugin', () => {
  let plugin

  afterEach(() => {
    plugin?.configure(false)
  })

  it('uses the effective framework received from a WebdriverIO worker', () => {
    plugin = new MochaPlugin({ _exporter: {} }, { testOptimization: {} })
    plugin.configure({ enabled: true })

    dc.channel('ci:mocha:worker:configuration').publish({
      libraryConfig: {},
      repositoryRoot: process.cwd(),
      testFramework: 'webdriverio',
    })

    assert.strictEqual(plugin.testFramework, 'webdriverio')
  })
})
