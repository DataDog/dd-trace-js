const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

const {
  CI_APP_ORIGIN,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_FRAMEWORK_VERSION,
  TEST_STATUS,
  JEST_TEST_RUNNER,
  finishAllTraceSpans,
  getTestEnvironmentMetadata,
  getTestParentSpan
} = require('../../dd-trace/src/plugins/util/test')
const { SPAN_TYPE, RESOURCE_NAME, SAMPLING_PRIORITY } = require('../../../ext/tags')
const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')
const { AUTO_KEEP } = require('../../../ext/priority')

function getTestSpanMetadata (tracer, test) {
  const childOf = getTestParentSpan(tracer)

  const { suite, name } = test

  return {
    childOf,
    [SPAN_TYPE]: 'test',
    [TEST_TYPE]: 'test',
    [TEST_NAME]: name,
    [TEST_SUITE]: suite,
    [SAMPLING_RULE_DECISION]: 1,
    [SAMPLING_PRIORITY]: AUTO_KEEP,
    [TEST_FRAMEWORK_VERSION]: tracer._version,
    [RESOURCE_NAME]: `${suite}.${name}`,
    [JEST_TEST_RUNNER]: 'jest-circus'
  }
}

class JestPlugin extends Plugin {
  static get name () {
    return 'jest'
  }

  constructor (...args) {
    super(...args)

    this.testEnvironmentMetadata = getTestEnvironmentMetadata('jest', this.config)

    this.addSub('ci:jest:test:start', (test) => {
      const store = storage.getStore()
      const span = this.startTestSpan(test)

      this.enter(span, store)
    })

    this.addSub('ci:jest:test:end', () => {
      const span = storage.getStore().span

      if (!span._spanContext._tags[TEST_STATUS]) {
        span.setTag(TEST_STATUS, 'pass')
      }
      span.finish()
      finishAllTraceSpans(span)
      this.exit()
    })

    this.addSub('ci:jest:test-suite:end', () => {
      this.tracer._exporter._writer.flush()
    })

    this.addSub('ci:jest:test:err', (err) => {
      if (err) {
        const span = storage.getStore().span
        span.setTag(TEST_STATUS, 'fail')
        span.setTag('error', err)
      }
    })
  }

  startTestSpan (test) {
    const { childOf, ...testSpanMetadata } = getTestSpanMetadata(this.tracer, test)

    const testSpan = this.tracer
      .startSpan('jest.test', {
        childOf,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSpanMetadata
        }
      })
    testSpan.context()._trace.origin = CI_APP_ORIGIN

    return testSpan
  }
}

module.exports = JestPlugin
