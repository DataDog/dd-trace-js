const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_ITR_FORCED_TO_RUN,
  TELEMETRY_CODE_COVERAGE_EMPTY,
  TELEMETRY_ITR_UNSKIPPABLE,
  TELEMETRY_CODE_COVERAGE_NUM_FILES,
  incrementCountMetric,
  distributionMetric
} = require('../../dd-trace/src/ci-visibility/telemetry')

function getSessionStatus (summary) {
  if (summary.totalFailed !== undefined && summary.totalFailed > 0) {
    return 'fail'
  }
  if (summary.totalSkipped !== undefined && summary.totalSkipped === summary.totalTests) {
    return 'skip'
  }
  return 'pass'
}

function getCiVisEvent (isUnsupportedCIProvider) {
  return function ciVisEvent (name, testLevel, tags = {}) {
    incrementCountMetric(name, {
      testLevel,
      testFramework: 'cypress',
      isUnsupportedCIProvider,
      ...tags
    })
  }
}

module.exports = {
  getSessionStatus,
  getCiVisEvent
}
