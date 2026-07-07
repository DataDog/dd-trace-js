'use strict'

const CiPlugin = require('../../plugins/ci_plugin')
const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath,
} = require('../../plugins/util/test')
const { storage } = require('../../../../datadog-core')

const legacyStorage = storage('legacy')

class TestApiManualPlugin extends CiPlugin {
  static id = 'test-api-manual'

  constructor (...args) {
    super(...args)
    this._isEnvDataCalcualted = false
    this.sourceRoot = process.cwd()

    this.unconfiguredAddSub('dd-trace:ci:manual:test:start', ({ testName, testSuite }) => {
      const store = legacyStorage.getStore()
      const testSuiteRelative = getTestSuitePath(testSuite, this.sourceRoot)
      const testSpan = this.startTestSpan(testName, testSuiteRelative)
      this.enter(testSpan, store)
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test:finish', ({ status, error }) => {
      const store = legacyStorage.getStore()
      const testSpan = store && store.span
      if (testSpan) {
        testSpan.setTag(TEST_STATUS, status)
        if (error) {
          testSpan.setTag('error', error)
        }
        testSpan.finish()
        finishAllTraceSpans(testSpan)
        // Null the span on the entered store so a captured async-context frame no
        // longer retains the finished test span. `store` is the frame entered for
        // this test at `:start`; the same read already drives `finish` above.
        store.span = null
      }
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test:addTags', (tags) => {
      const store = legacyStorage.getStore()
      const testSpan = store && store.span
      if (testSpan) {
        testSpan.addTags(tags)
      }
    })
  }

  // To lazily calculate env data.
  unconfiguredAddSub (channelName, handler) {
    this.addSub(channelName, (...args) => {
      if (!this._isEnvDataCalcualted) {
        this._isEnvDataCalcualted = true
        this.configure(this._config, true)
      }
      return handler(...args)
    })
  }

  /**
   * @param {import('../../config/config-base')} config - Tracer configuration
   * @param {boolean} shouldGetEnvironmentData - Whether to get environment data
   */
  configure (config, shouldGetEnvironmentData) {
    this._config = config
    super.configure(config, shouldGetEnvironmentData)
  }
}

module.exports = TestApiManualPlugin
