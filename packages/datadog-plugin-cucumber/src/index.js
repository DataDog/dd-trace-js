'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

const {
  CI_APP_ORIGIN,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_SKIP_REASON,
  TEST_FRAMEWORK_VERSION,
  ERROR_MESSAGE,
  TEST_STATUS,
  finishAllTraceSpans,
  getTestEnvironmentMetadata,
  getTestSuitePath
} = require('../../dd-trace/src/plugins/util/test')
const { SPAN_TYPE, RESOURCE_NAME } = require('../../../ext/tags')
const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')

function setStatusFromResult (span, result, tag) {
  if (result.status === 1) {
    span.setTag(tag, 'pass')
  } else if (result.status === 2) {
    span.setTag(tag, 'skip')
  } else if (result.status === 4) {
    span.setTag(tag, 'skip')
    span.setTag(TEST_SKIP_REASON, 'not implemented')
  } else {
    span.setTag(tag, 'fail')
    span.setTag(ERROR_MESSAGE, result.message)
  }
}

function setStatusFromResultLatest (span, result, tag) {
  if (result.status === 'PASSED') {
    span.setTag(tag, 'pass')
  } else if (result.status === 'SKIPPED' || result.status === 'PENDING') {
    span.setTag(tag, 'skip')
  } else if (result.status === 'UNDEFINED') {
    span.setTag(tag, 'skip')
    span.setTag(TEST_SKIP_REASON, 'not implemented')
  } else {
    span.setTag(tag, 'fail')
    span.setTag(ERROR_MESSAGE, result.message)
  }
}

class CucumberPlugin extends Plugin {
  static get name () {
    return 'cucumber'
  }

  constructor (...args) {
    super(...args)

    const testEnvironmentMetadata = getTestEnvironmentMetadata('cucumber', this.config)
    const sourceRoot = process.cwd()

    this.addSub('ci:cucumber:run:start', ({ pickleName, pickleUri }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const testSuite = getTestSuitePath(pickleUri, sourceRoot)

      const span = this.tracer.startSpan('cucumber.test', {
        childOf,
        tags: {
          [SPAN_TYPE]: 'test',
          [RESOURCE_NAME]: pickleName,
          [TEST_TYPE]: 'test',
          [TEST_NAME]: pickleName,
          [TEST_SUITE]: testSuite,
          [SAMPLING_RULE_DECISION]: 1,
          [TEST_FRAMEWORK_VERSION]: this.tracer._version,
          ...testEnvironmentMetadata
        }
      })
      span.context()._trace.origin = CI_APP_ORIGIN
      this.enter(span, store)
    })

    this.addSub('ci:cucumber:run:end', () => {
      this.exit()
    })

    this.addSub('ci:cucumber:run-step:start', ({ resource }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('cucumber.step', {
        childOf,
        tags: {
          'cucumber.step': resource,
          [RESOURCE_NAME]: resource
        }
      })
      this.enter(span, store)
    })

    this.addSub('ci:cucumber:run-step:end', () => {
      this.exit()
    })

    this.addSub('ci:cucumber:run:async-end', ({ result, isStep, isLatestVersion }) => {
      const span = storage.getStore().span
      const tag = isStep ? 'step.status' : TEST_STATUS
      if (isLatestVersion) {
        setStatusFromResultLatest(span, result, tag)
      } else {
        setStatusFromResult(span, result, tag)
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
}

module.exports = CucumberPlugin
