const {
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  TEST_FRAMEWORK_VERSION,
  getTestEnvironmentMetadata,
  CI_APP_ORIGIN,
  getTestParentSpan
} = require('../../dd-trace/src/plugins/util/test')

const { SAMPLING_RULE_DECISION, ORIGIN_KEY } = require('../../dd-trace/src/constants')
const { SAMPLING_PRIORITY, SPAN_TYPE, RESOURCE_NAME } = require('../../../ext/tags')
const { AUTO_KEEP } = require('../../../ext/priority')

const CYPRESS_STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  pending: 'skip',
  skipped: 'skip'
}

function getTestSpanMetadata (tracer, testName, testSuite, cypressConfig, additionalSpans) {
  const childOf = getTestParentSpan(tracer)

  return {
    childOf,
    resource: `${testSuite}.${testName}`,
    [TEST_TYPE]: 'test',
    [TEST_NAME]: testName,
    [TEST_SUITE]: testSuite,
    [SAMPLING_RULE_DECISION]: 1,
    [SAMPLING_PRIORITY]: AUTO_KEEP,
    [TEST_FRAMEWORK_VERSION]: cypressConfig.version,
    ...additionalSpans
  }
}

module.exports = (on, config) => {
  const tracer = require('../../dd-trace')
  const testEnvironmentMetadata = getTestEnvironmentMetadata('cypress')
  let activeSpan = null
  on('after:run', () => {
    return new Promise(resolve => {
      tracer._tracer._exporter._writer.flush(() => resolve(null))
    })
  })
  on('task', {
    'dd:beforeEach': (test) => {
      const { testName, testSuite, ...additionalSpans } = test

      const {
        childOf,
        resource,
        ...testSpanMetadata
      } = getTestSpanMetadata(tracer, testName, testSuite, config, additionalSpans)

      if (!activeSpan) {
        activeSpan = tracer.startSpan('cypress.test', {
          childOf,
          tags: {
            [SPAN_TYPE]: 'test',
            [RESOURCE_NAME]: resource,
            [ORIGIN_KEY]: CI_APP_ORIGIN,
            ...testSpanMetadata,
            ...testEnvironmentMetadata
          }
        })
      }
      return null
    },
    'dd:afterEach': (test) => {
      const { state, error, ...additionalSpans } = test
      if (activeSpan) {
        activeSpan.setTag(TEST_STATUS, CYPRESS_STATUS_TO_TEST_STATUS[state])
        if (error) {
          activeSpan.setTag('error', error)
        }
        Object.entries(additionalSpans).forEach(([key, value]) => {
          activeSpan.setTag(key, value)
        })
        activeSpan.finish()
      }
      activeSpan = null
      return null
    }
  })
}
