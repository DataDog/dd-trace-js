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
  TEST_CODE_OWNERS,
  finishAllTraceSpans,
  getTestEnvironmentMetadata,
  getTestSuitePath,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename
} = require('../../dd-trace/src/plugins/util/test')
const { SPAN_TYPE, RESOURCE_NAME, SAMPLING_PRIORITY } = require('../../../ext/tags')
const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')
const { AUTO_KEEP } = require('../../../ext/priority')

class CucumberPlugin extends Plugin {
  static get name () {
    return 'cucumber'
  }

  constructor (...args) {
    super(...args)

    const testEnvironmentMetadata = getTestEnvironmentMetadata('cucumber', this.config)
    const sourceRoot = process.cwd()
    const codeOwnersEntries = getCodeOwnersFileEntries(sourceRoot)

    this.addSub('ci:cucumber:run:start', ({ pickleName, pickleUri }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const testSuite = getTestSuitePath(pickleUri, sourceRoot)

      const testSpanMetadata = {
        [SPAN_TYPE]: 'test',
        [RESOURCE_NAME]: pickleName,
        [TEST_TYPE]: 'test',
        [TEST_NAME]: pickleName,
        [TEST_SUITE]: testSuite,
        [SAMPLING_RULE_DECISION]: 1,
        [SAMPLING_PRIORITY]: AUTO_KEEP,
        [TEST_FRAMEWORK_VERSION]: this.tracer._version,
        ...testEnvironmentMetadata
      }

      const codeOwners = getCodeOwnersForFilename(testSuite, codeOwnersEntries)
      if (codeOwners) {
        testSpanMetadata[TEST_CODE_OWNERS] = codeOwners
      }

      const span = this.tracer.startSpan('cucumber.test', {
        childOf,
        tags: testSpanMetadata
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

    this.addSub('ci:cucumber:run:async-end', ({ isStep, status, skipReason, errorMessage }) => {
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
}

module.exports = CucumberPlugin
