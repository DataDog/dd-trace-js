const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_IS_RUM_ACTIVE,
  TEST_BROWSER_DRIVER,
  TEST_BROWSER_DRIVER_VERSION,
  TEST_BROWSER_NAME,
  TEST_BROWSER_VERSION,
  TEST_TYPE
} = require('../../dd-trace/src/plugins/util/test')
const { SPAN_TYPE } = require('../../../ext/tags')

function isTestSpan (span) {
  return span.context()._tags[SPAN_TYPE] === 'test'
}

function getTestSpanFromTrace (trace) {
  for (const span of trace.started) {
    if (isTestSpan(span)) {
      return span
    }
  }
  return null
}

class SeleniumPlugin extends CiPlugin {
  static get id () {
    return 'selenium'
  }

  constructor (...args) {
    super(...args)

    this.addSub('ci:selenium:driver:get', ({
      setTraceId,
      seleniumVersion,
      browserName,
      browserVersion,
      isRumActive
    }) => {
      const store = storage.getStore()
      const span = store?.span
      if (!span) {
        return
      }
      let testSpan
      if (isTestSpan(span)) {
        testSpan = span
      } else {
        testSpan = getTestSpanFromTrace(span.context()._trace)
      }
      if (!testSpan) {
        return
      }
      if (setTraceId) {
        setTraceId(testSpan.context().toTraceId())
      }
      if (isRumActive) {
        testSpan.setTag(TEST_IS_RUM_ACTIVE, 'true')
      }
      testSpan.setTag(TEST_BROWSER_DRIVER, 'selenium')
      testSpan.setTag(TEST_BROWSER_DRIVER_VERSION, seleniumVersion)
      testSpan.setTag(TEST_BROWSER_NAME, browserName)
      testSpan.setTag(TEST_BROWSER_VERSION, browserVersion)
      testSpan.setTag(TEST_TYPE, 'browser')
    })
  }
}

module.exports = SeleniumPlugin
