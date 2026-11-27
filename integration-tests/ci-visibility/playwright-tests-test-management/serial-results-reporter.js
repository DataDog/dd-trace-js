'use strict'

class SerialResultsReporter {
  /**
   * @param {import('@playwright/test/reporter').FullConfig} config
   * @param {import('@playwright/test/reporter').Suite} suite
   */
  onBegin (config, suite) {
    this.suite = suite
  }

  onEnd () {
    const results = this.suite.allTests().map(test => ({
      title: test.title,
      statuses: test.results.map(result => result.status),
      outcome: test.outcome(),
      workerHash: test._workerHash,
    }))
    process.stdout.write(`SERIAL_RESULTS=${JSON.stringify(results)}\n`)
  }
}

module.exports = SerialResultsReporter
