const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')

const {
  TEST_STATUS,
  finishAllTraceSpans
} = require('../../dd-trace/src/plugins/util/test')

class ManualPlugin extends CiPlugin {
  static get id () {
    return 'manual'
  }
  constructor (...args) {
    super(...args)
    let activeTestSpan

    this.addSub('ci:manual:test:start', ({ testName, testSuite }) => {
      activeTestSpan = this.startTestSpan(testName, testSuite)
    })
    this.addSub('ci:manual:test:finish', ({ status }) => {
      activeTestSpan.setTag(TEST_STATUS, status)
      activeTestSpan.finish()
      finishAllTraceSpans(activeTestSpan)
    })
  }
}

module.exports = ManualPlugin
