const {
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  getTestEnvironmentMetadata
} = require('../../dd-trace/src/plugins/util/test')

const id = require('../../dd-trace/src/id')
const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')
const {
  SAMPLING_PRIORITY,
  SPAN_TYPE,
  RESOURCE_NAME,
  SPAN_KIND,
  HTTP_METHOD,
  HTTP_URL
} = require('../../../ext/tags')
const { AUTO_KEEP } = require('../../../ext/priority')

const CYPRESS_STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  pending: 'skip',
  skipped: 'skip'
}

function getTestSpanMetadata (tracer, testName, testSuite) {
  const childOf = tracer.extract('text_map', {
    'x-datadog-trace-id': id().toString(10),
    'x-datadog-parent-id': '0000000000000000',
    'x-datadog-sampled': 1
  })

  return {
    childOf,
    resource: `${testSuite}.${testName}`,
    [TEST_TYPE]: 'test',
    [TEST_NAME]: testName,
    [TEST_SUITE]: testSuite,
    [SAMPLING_RULE_DECISION]: 1,
    [SAMPLING_PRIORITY]: AUTO_KEEP
  }
}

module.exports = (on, config) => {
  const tracer = require('../../dd-trace').init({
    startupLogs: false,
    plugins: false
  })
  const testEnvironmentMetadata = getTestEnvironmentMetadata('cypress')
  let activeSpan = null
  on('task', {
    beforeEach: (test) => {
      const { testName, testSuite } = test

      const {
        childOf,
        resource,
        ...testSpanMetadata
      } = getTestSpanMetadata(tracer, testName, testSuite)

      if (!activeSpan) {
        activeSpan = tracer.startSpan('cypress.test', {
          childOf,
          tags: {
            [SPAN_TYPE]: 'test',
            [RESOURCE_NAME]: resource,
            ...testSpanMetadata,
            ...testEnvironmentMetadata
          }
        })
      }
      return null
    },
    afterEach: (test) => {
      const { state, error, httpRequests } = test
      if (activeSpan) {
        activeSpan.setTag(TEST_STATUS, CYPRESS_STATUS_TO_TEST_STATUS[state])
        if (error) {
          activeSpan.setTag('error.msg', error.message)
          activeSpan.setTag('error.type', error.name)
          activeSpan.setTag('error.stack', error.stack)
        }
        // Add http spans
        if (httpRequests) {
          httpRequests.forEach((httpRequest) => {
            const httpSpan = tracer.startSpan('http.request', {
              childOf: activeSpan,
              tags: {
                [SPAN_KIND]: 'client',
                [RESOURCE_NAME]: httpRequest.method,
                [SPAN_TYPE]: 'http',
                [HTTP_METHOD]: httpRequest.method,
                [HTTP_URL]: httpRequest.url
              }
            })
            // We have to hack timestamps because we can't generate spans as the requests happen
            httpSpan._startTime = httpRequest.startClocks.timeStamp
            httpSpan.finish(httpRequest.startClocks.timeStamp + httpRequest.duration)
          })
        }

        activeSpan.finish()
      }
      activeSpan = null
      return null
    }
  })
}
