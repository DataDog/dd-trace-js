const {
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  TEST_FRAMEWORK_VERSION,
  TEST_IS_RUM_ACTIVE,
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

function getTestSpanMetadata (tracer, testName, testSuite, cypressConfig) {
  const childOf = getTestParentSpan(tracer)

  return {
    childOf,
    resource: `${testSuite}.${testName}`,
    [TEST_TYPE]: 'test',
    [TEST_NAME]: testName,
    [TEST_SUITE]: testSuite,
    [SAMPLING_RULE_DECISION]: 1,
    [SAMPLING_PRIORITY]: AUTO_KEEP,
    [TEST_FRAMEWORK_VERSION]: cypressConfig.version
  }
}

module.exports = (on, config) => {
  const tracer = require('../../dd-trace')
  const testEnvironmentMetadata = getTestEnvironmentMetadata('cypress')
  let activeSpan = null
  on('after:run', () => {
    return new Promise(resolve => {
      tracer._tracer._flush(() => resolve(null))
    })
  })
  on('task', {
    'dd:beforeEach': (test) => {
      const { testName, testSuite } = test

      const {
        childOf,
        resource,
        ...testSpanMetadata
      } = getTestSpanMetadata(tracer, testName, testSuite, config)

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
      return activeSpan ? activeSpan._spanContext._traceId.toString(10) : null
    },
    'dd:afterEach': (test) => {
      const { state, error, isRUMActive } = test
      if (activeSpan) {
        activeSpan.setTag(TEST_STATUS, CYPRESS_STATUS_TO_TEST_STATUS[state])
        if (error) {
          activeSpan.setTag('error', error)
        }
        if (isRUMActive) {
          activeSpan.setTag(TEST_IS_RUM_ACTIVE, 'true')
        }
        activeSpan.finish()
      }
      activeSpan = null
      return null
    },
    'dd:addTags': (tags) => {
      if (activeSpan) {
        activeSpan.addTags(tags)
      }
      return null
    }
  })
}
