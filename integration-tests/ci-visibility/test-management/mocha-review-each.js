'use strict'

const forEach = require('mocha-each')
const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

const declare = rows => {
  const cases = forEach(rows)
  return process.env.MOCHA_REVIEW_ONLY === '1' ? cases.it.only : cases.it
}
const failingCases = declare([1, 2])
failingCases('case %s', preventFailureSuppression(noAutoRetry((value, done) => {
  done(new Error(`protected parameterized failure ${value}`))
})))
const passingCases = declare([3])
passingCases('passing %s', preventFailureSuppression(noAutoRetry((value, done) => done())))

const skipped = () => forEach([4]).it.skip('skipped %s', preventFailureSuppression(noAutoRetry(() => {})))
if (process.env.MOCHA_REVIEW_ONLY === '1') {
  // eslint-disable-next-line mocha/no-empty-title, mocha/no-exclusive-tests -- matches mocha-each exclusive suites
  describe.only('', skipped)
} else skipped()
