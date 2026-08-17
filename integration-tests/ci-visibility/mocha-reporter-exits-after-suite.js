'use strict'

module.exports = function ExitingReporter (runner) {
  runner.on('suite end', (suite) => {
    if (suite.title !== 'mocha-test-pass-two') return

    const exporter = require('dd-trace')._tracer._exporter
    exporter.flush(() => process.exit(0))
  })
}
