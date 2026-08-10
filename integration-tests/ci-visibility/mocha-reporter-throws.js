'use strict'

module.exports = function ThrowingReporter (runner) {
  const event = process.env.MOCHA_REPORTER_THROW_EVENT || 'end'

  runner.on(event, runnable => {
    if (event === 'pass' && runnable.parent.title !== 'mocha-test-pass-two') return
    if (event === 'suite end' && runnable.title !== 'mocha-test-pass-two') return

    throw new Error('custom Mocha reporter failed')
  })
}
