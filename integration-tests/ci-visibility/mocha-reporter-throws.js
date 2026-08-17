'use strict'

const fs = require('node:fs')

module.exports = function ThrowingReporter (runner) {
  const event = process.env.MOCHA_REPORTER_THROW_EVENT || 'end'
  let failedTest

  if (process.env.MOCHA_REPORT_RUNNER_EMIT_OWNER) {
    fs.writeSync(2, `MOCHA RUNNER OWNS EMIT: ${Object.hasOwn(Object.getPrototypeOf(runner), 'emit')}\n`)
  }
  if (process.env.MOCHA_REPORT_PENDING_AT_END) {
    runner.on('end', () => {
      fs.writeSync(2, `REPORTER TEST PENDING AT END: ${failedTest?.pending}\n`)
    })
  }

  runner.on(event, runnable => {
    if ((event === 'pass' || event === 'test end') && runnable.parent.title !== 'mocha-test-pass-two') return
    if (event === 'hook' && process.env.MOCHA_REPORTER_THROW_AFTER_EACH &&
      !runnable.parent?._afterEach?.includes(runnable)) return
    if (event === 'hook' && process.env.MOCHA_REPORTER_THROW_AFTER_ALL &&
      !runnable.parent?._afterAll?.includes(runnable)) return
    if (event === 'hook end' && process.env.MOCHA_REPORTER_THROW_INNER_HOOK &&
      runnable.parent.title !== 'mocha-reporter-hook-end-inner') return
    if (event === 'suite' && (runnable.root || runnable.title !== 'mocha-test-pass')) return
    if (event === 'suite end' && runnable.title !== 'mocha-test-pass-two') return

    failedTest = runnable?.type === 'test' ? runnable : runnable?.ctx?.currentTest
    if (process.env.MOCHA_REPORTER_THROWS_UNDEFINED) {
      // eslint-disable-next-line no-throw-literal
      throw undefined
    }
    if (process.env.MOCHA_REPORTER_THROWS_UNCOERCIBLE) {
      throw Object.create(null)
    }
    if (process.env.MOCHA_REPORTER_THROWS_HOSTILE_ERROR) {
      const error = new Error('custom Mocha reporter failed')
      Object.defineProperty(error, 'message', {
        get () { throw new Error('do not read reporter error message') },
      })
      throw error
    }
    throw new Error('custom Mocha reporter failed')
  })
}
