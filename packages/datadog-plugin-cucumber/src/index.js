'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

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
const { SAMPLING_PRIORITY } = require('../../../ext/tags')
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

    this.addSub('ci:cucumber:run:start', ({ pickleName, pickleUri }) => {
      const testSuite = getTestSuitePath(pickleUri, sourceRoot)

      const span = this.startSpan('cucumber.test', {
        resource: pickleName,
        type: 'test',
        meta: {
          [TEST_TYPE]: 'test',
          [TEST_NAME]: pickleName,
          [TEST_SUITE]: testSuite,
          [SAMPLING_RULE_DECISION]: 1,
          [SAMPLING_PRIORITY]: AUTO_KEEP,
          [TEST_FRAMEWORK_VERSION]: this.tracer._version,
          ...testEnvironmentMetadata
        }
      })

      span.trace.samplingPiority = 1 // TODO: go through a sampler
      span.trace.origin = CI_APP_ORIGIN
    })

    this.addSub('ci:cucumber:run:end', () => {
      this.exit()
    })

    this.addSub('ci:cucumber:run-step:start', ({ resource }) => {
      this.startSpan('cucumber.step', {
        resource,
        meta: {
          'cucumber.step': resource
        }
      })
    })

    this.addSub('ci:cucumber:run-step:end', () => {
      this.exit()
    })

    this.addSub('ci:cucumber:run:async-end', ({ isStep, status, skipReason, errorMessage }) => {
      const span = this.activeSpan
      const statusTag = isStep ? 'step.status' : TEST_STATUS

      span.meta[statusTag] = status
      span.meta[TEST_SKIP_REASON] = skipReason
      span.meta[ERROR_MESSAGE] = errorMessage

      this.finishSpan(span)

      if (!isStep) {
        finishAllTraceSpans(span)
      }
    })

    this.addSub('ci:cucumber:error', (err) => {
      this.addError(err)
    })
  }
}

module.exports = CucumberPlugin
