'use strict'

/**
 * @param {import('mocha').Runner} runner
 */
module.exports = function RootCoverageReporter (runner) {
  function getSumHits () {
    const coverage = Object.values(global.__coverage__).find(({ path }) => path.endsWith('/test/sum.js'))
    return coverage.f[0]
  }

  runner.on('suite end', suite => {
    if (!suite.root) return
    // eslint-disable-next-line no-console
    console.log(`MOCHA ROOT REPORTER COVERAGE: ${getSumHits()}`)
    if (process.env.MOCHA_COVERAGE_REPORTER_THROWS) {
      throw new Error('custom Mocha coverage reporter failed')
    }
  })

  runner.on('end', () => {
    // eslint-disable-next-line no-console
    console.log(`MOCHA ROOT COVERAGE AFTER REPORTERS: ${getSumHits()}`)
  })
}
