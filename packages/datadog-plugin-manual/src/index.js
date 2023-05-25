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
    this.addSub('ci:manual:test:start', (test) => {
      activeTestSpan = this.startTestSpan(test)
    })
    this.addSub('ci:manual:test:end', ({ status }) => {
      activeTestSpan.setTag(TEST_STATUS, status)
      activeTestSpan.finish()
      finishAllTraceSpans(activeTestSpan)
    })
  }
  startTestSpan (testName) {
    return super.startTestSpan(testName, 'my-test-file.js')
  }
}

module.exports = ManualPlugin
