'use strict'

const JEST_SESSION_STATE = Symbol.for('dd-trace:jest:session')

class DatadogJestBailReporter {
  /**
   * @param {{ bail?: number, collectCoverage?: boolean, coverage?: boolean }} globalConfig
   */
  constructor (globalConfig) {
    this.globalConfig = globalConfig
  }

  /**
   * @param {Set<object>} _testContexts
   * @param {{ numFailedTests?: number, numFailedTestSuites?: number, numRuntimeErrorTestSuites?: number }} results
   * @returns {Promise<void> | void}
   */
  onRunComplete (_testContexts, results) {
    const numBailFailures = getNumBailFailures(results)
    if (
      !this.globalConfig.bail ||
      this.globalConfig.collectCoverage ||
      this.globalConfig.coverage ||
      numBailFailures < this.globalConfig.bail
    ) {
      return
    }

    return globalThis[JEST_SESSION_STATE]?.finishBailTestSession?.(results)
  }
}

function getNumBailFailures (results) {
  const numFailedTests = results?.numFailedTests || 0
  const numFailedSuites = results?.numRuntimeErrorTestSuites === undefined
    ? (numFailedTests === 0 ? results?.numFailedTestSuites || 0 : 0)
    : results.numRuntimeErrorTestSuites

  return numFailedTests + numFailedSuites
}

module.exports = DatadogJestBailReporter
