'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

const {
  CI_APP_ORIGIN,
  TEST_SKIP_REASON,
  ERROR_MESSAGE,
  TEST_STATUS,
  TEST_CODE_OWNERS,
  finishAllTraceSpans,
  getTestEnvironmentMetadata,
  getTestSuitePath,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  getTestCommonTags
} = require('../../dd-trace/src/plugins/util/test')
const { RESOURCE_NAME } = require('../../../ext/tags')
const { COMPONENT } = require('../../dd-trace/src/constants')

class CucumberPlugin extends Plugin {
  static get name () {
    return 'cucumber'
  }

  constructor (...args) {
    super(...args)

    const testEnvironmentMetadata = getTestEnvironmentMetadata('cucumber', this.config)
    const sourceRoot = process.cwd()
    const codeOwnersEntries = getCodeOwnersFileEntries(sourceRoot)

    this.addSub('ci:cucumber:session:finish', () => {
      this.tracer._exporter._writer.flush()
    })

    this.addSub('ci:cucumber:run:start', ({ pickleName, pickleUri }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const testSuite = getTestSuitePath(pickleUri, sourceRoot)

      const commonTags = getTestCommonTags(pickleName, testSuite, this.tracer._version)

      const codeOwners = getCodeOwnersForFilename(testSuite, codeOwnersEntries)
      if (codeOwners) {
        commonTags[TEST_CODE_OWNERS] = codeOwners
      }

      const span = this.tracer.startSpan('cucumber.test', {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.name,
          ...commonTags,
          ...testEnvironmentMetadata
        }
      })

      span.context()._trace.origin = CI_APP_ORIGIN
      this.enter(span, store)
    })

    this.addSub('ci:cucumber:run-step:start', ({ resource }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('cucumber.step', {
        childOf,
        tags: {
          "component": "cucumber",
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
}

module.exports = CucumberPlugin
