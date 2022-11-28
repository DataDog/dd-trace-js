'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_SKIP_REASON,
  ERROR_MESSAGE,
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath
} = require('../../dd-trace/src/plugins/util/test')
const { RESOURCE_NAME } = require('../../../ext/tags')
const { COMPONENT } = require('../../dd-trace/src/constants')

class CucumberPlugin extends CiPlugin {
  static get name () {
    return 'cucumber'
  }

  constructor (...args) {
    super(...args)

    this.addSub('ci:cucumber:session:finish', () => {
      this.tracer._exporter._writer.flush()
    })

    this.addSub('ci:cucumber:run:start', ({ testName, fullTestSuite }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const testSuite = getTestSuitePath(fullTestSuite, process.cwd())

      const testSpan = this.startTestSpan(testName, testSuite, childOf)

      this.enter(testSpan, store)
    })

    this.addSub('ci:cucumber:run-step:start', ({ resource }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('cucumber.step', {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.name,
          'cucumber.step': resource,
          [RESOURCE_NAME]: resource
        }
      })
      this.enter(span, store)
    })

    this.addSub('ci:cucumber:run:finish', ({ isStep, status, skipReason, errorMessage }) => {
      const span = storage.getStore().span
      const statusTag = isStep ? 'step.status' : TEST_STATUS

      span.setTag(statusTag, status)

      if (skipReason) {
        span.setTag(TEST_SKIP_REASON, skipReason)
      }

      if (errorMessage) {
        span.setTag(ERROR_MESSAGE, errorMessage)
      }

      span.finish()
      if (!isStep) {
        finishAllTraceSpans(span)
      }
    })

    this.addSub('ci:cucumber:error', (err) => {
      if (err) {
        const span = storage.getStore().span
        span.setTag('error', err)
      }
    })
  }

  startTestSpan (testName, testSuite, childOf) {
    return super.startTestSpan(testName, testSuite, {}, childOf)
  }
}

module.exports = CucumberPlugin
