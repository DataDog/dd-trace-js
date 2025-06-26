'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')
const {
  TEST_STATUS,
  TEST_FRAMEWORK_VERSION,
  TEST_SOURCE_FILE,
  finishAllTraceSpans
} = require('../../dd-trace/src/plugins/util/test')

class NodeTestPlugin extends CiPlugin {
  static get id () {
    return 'node-test'
  }

  constructor (...args) {
    super(...args)

    this.addBind('ci:node-test:test:start', (ctx) => {
      const store = storage('legacy').getStore()
      const span = this.startTestSpan(ctx)

      ctx.parentStore = store
      ctx.currentStore = { ...store, span }

      this.activeTestSpan = span

      return ctx.currentStore
    })

    this.addSub('ci:node-test:test:finish', ({ span, status }) => {
      span.setTag(TEST_STATUS, status)

      span.finish()
      finishAllTraceSpans(span)
      this.activeTestSpan = null
    })
  }

  startTestSpan (test) {
    const {
      name,
      suite,
      frameworkVersion,
      testSourceFile,
    } = test

    const extraTags = {
      [TEST_FRAMEWORK_VERSION]: frameworkVersion
    }

    if (testSourceFile) {
      extraTags[TEST_SOURCE_FILE] = testSourceFile
    }

    return super.startTestSpan(name, suite, this.testSuiteSpan, extraTags)
  }
}

module.exports = NodeTestPlugin
