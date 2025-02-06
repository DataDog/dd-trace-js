const CiPlugin = require('../../plugins/ci_plugin')
const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath
} = require('../../plugins/util/test')
const { storage } = require('../../../../datadog-core')

class TestApiManualPlugin extends CiPlugin {
  static get id () {
    return 'test-api-manual'
  }

  constructor (...args) {
    super(...args)
    this._isEnvDataCalcualted = false
    this.sourceRoot = process.cwd()

    this.unconfiguredAddSub('dd-trace:ci:manual:test:start', ({ testName, testSuite }) => {
      const store = storage('legacy').getStore()
      const testSuiteRelative = getTestSuitePath(testSuite, this.sourceRoot)
      const testSpan = this.startTestSpan(testName, testSuiteRelative)
      this.enter(testSpan, store)
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test:finish', ({ status, error }) => {
      const store = storage('legacy').getStore()
      const testSpan = store && store.span
      if (testSpan) {
        testSpan.setTag(TEST_STATUS, status)
        if (error) {
          testSpan.setTag('error', error)
        }
        testSpan.finish()
        finishAllTraceSpans(testSpan)
      }
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test:addTags', (tags) => {
      const store = storage('legacy').getStore()
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

  configure (config, shouldGetEnvironmentData) {
    this._config = config
    super.configure(config, shouldGetEnvironmentData)
  }
}

module.exports = TestApiManualPlugin
