'use strict'

module.exports = function ThrowingReporter (runner) {
  const event = process.env.MOCHA_REPORTER_THROW_EVENT || 'end'

  runner.on(event, runnable => {
    if ((event === 'pass' || event === 'test end') && runnable.parent.title !== 'mocha-test-pass-two') return
    if (event === 'suite' && (runnable.root || runnable.title !== 'mocha-test-pass')) return
    if (event === 'suite end' && runnable.title !== 'mocha-test-pass-two') return

    if (process.env.MOCHA_REPORTER_THROWS_UNDEFINED) {
      // eslint-disable-next-line no-throw-literal
      throw undefined
    }
    throw new Error('custom Mocha reporter failed')
  })
}
