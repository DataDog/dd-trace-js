'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const sinon = require('sinon')

const { storage } = require('../../datadog-core')
const {
  TEST_BROWSER_VERSION,
  TEST_IS_RUM_ACTIVE,
} = require('../../dd-trace/src/plugins/util/test')
const PlaywrightPlugin = require('../src')

const legacyStorage = storage('legacy')

describe('PlaywrightPlugin', () => {
  let plugin

  beforeEach(() => {
    plugin = new PlaywrightPlugin({}, { testOptimization: {} })
    plugin.configure({ enabled: true }, false)
  })

  afterEach(() => {
    plugin.configure(false)
  })

  it('provides the active test identity without owning the Playwright page', () => {
    const setTag = sinon.spy()
    const span = {
      context: () => ({
        toTraceId: () => 'test-execution-id',
      }),
      setTag,
    }
    const onDone = sinon.spy()

    legacyStorage.run({ span }, () => {
      channel('ci:playwright:test:page-goto').publish({
        browserVersion: 'browser-version',
        isRumActive: true,
        onDone,
      })
    })

    sinon.assert.calledWithExactly(setTag, TEST_IS_RUM_ACTIVE, 'true')
    sinon.assert.calledWithExactly(setTag, TEST_BROWSER_VERSION, 'browser-version')
    sinon.assert.calledOnceWithExactly(onDone, 'test-execution-id')
    assert.strictEqual(setTag.callCount, 2)
  })
})
