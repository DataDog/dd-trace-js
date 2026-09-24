'use strict'

module.exports = function CoverageReporter (runner) {
  runner.on('suite end', suite => {
    if (suite.root || suite.title !== 'mocha-coverage-reporter') return

    const [coverage] = Object.values(global.__coverage__)
    // eslint-disable-next-line no-console
    console.log(`MOCHA REPORTER COVERAGE: ${coverage.s[0]}`)
    if (process.env.MOCHA_COVERAGE_REPORTER_THROWS) {
      throw new Error('custom Mocha coverage reporter failed')
    }
  })
}
