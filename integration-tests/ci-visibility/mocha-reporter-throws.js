'use strict'

module.exports = function ThrowingReporter (runner) {
  const event = process.env.MOCHA_REPORTER_THROW_EVENT || 'end'

  runner.on(event, runnable => {
    if ((event === 'pass' || event === 'test end') && runnable.parent.title !== 'mocha-test-pass-two') return
    if (event === 'hook' && process.env.MOCHA_REPORTER_THROW_AFTER_EACH &&
      !runnable.parent?._afterEach?.includes(runnable)) return
    if (event === 'hook end' && process.env.MOCHA_REPORTER_THROW_INNER_HOOK &&
      runnable.parent.title !== 'mocha-reporter-hook-end-inner') return
    if (event === 'suite' && (runnable.root || runnable.title !== 'mocha-test-pass')) return
    if (event === 'suite end' && runnable.title !== 'mocha-test-pass-two') return

    if (process.env.MOCHA_REPORTER_THROWS_UNDEFINED) {
      // eslint-disable-next-line no-throw-literal
      throw undefined
    }
    if (process.env.MOCHA_REPORTER_THROWS_UNCOERCIBLE) {
      throw Object.create(null)
    }
    throw new Error('custom Mocha reporter failed')
  })
}
