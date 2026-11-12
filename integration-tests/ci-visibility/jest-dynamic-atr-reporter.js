'use strict'

module.exports = class DynamicAtrReporter {
  /**
   * @param {unknown} test
   * @param {{ title: string, status: string, failureMessages: string[], invocations: number }} result
   */
  onTestCaseResult (test, result) {
    process.stdout.write(`DYNAMIC_ATR_CASE:${JSON.stringify({
      name: result.title,
      status: result.status,
      errors: result.failureMessages.length,
      invocations: result.invocations,
    })}\n`)
  }
}
