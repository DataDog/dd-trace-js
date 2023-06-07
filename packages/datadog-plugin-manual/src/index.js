const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath
} = require('../../dd-trace/src/plugins/util/test')

class ManualPlugin extends CiPlugin {
  static get id () {
    return 'manual'
  }
  constructor (...args) {
    super(...args)
    this.sourceRoot = process.cwd()

    this.addSub('dd-trace:ci:manual:test:start', ({ testName, testSuite }) => {
      const store = storage.getStore()
      const testSuiteRelative = getTestSuitePath(testSuite, this.sourceRoot)
      const testSpan = this.startTestSpan(testName, testSuiteRelative)
      this.enter(testSpan, store)
    })
    this.addSub('dd-trace:ci:manual:test:finish', ({ status, error }) => {
      const store = storage.getStore()
      if (store && store.span) {
        const testSpan = store.span
        testSpan.setTag(TEST_STATUS, status)
        if (error) {
          testSpan.setTag('error', error)
        }
        testSpan.finish()
        finishAllTraceSpans(testSpan)
      }
    })
  }
}

module.exports = ManualPlugin
