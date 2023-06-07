const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const {
  TEST_STATUS,
  finishAllTraceSpans
} = require('../../dd-trace/src/plugins/util/test')
const { storage } = require('../../datadog-core')

class ManualPlugin extends CiPlugin {
  static get id () {
    return 'manual'
  }
  constructor (...args) {
    super(...args)

    this.addSub('dd-trace:ci:manual:test:start', ({ testName, testSuite }) => {
      const store = storage.getStore()
      const testSpan = this.startTestSpan(testName, testSuite)
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
