'use strict'

const Mocha = require('mocha')

const reporterEvent = process.env.MOCHA_REUSABLE_REPORTER_EVENT
const runCallbackThrows = process.env.MOCHA_REUSABLE_RUN_CALLBACK_THROWS
let reporterRun = 0
let firstRunFinished = false
let firstRunError
let hasStartedSecondRun = false

class ThrowOnceReporter {
  constructor (runner) {
    reporterRun++
    if (!reporterEvent || reporterRun !== 1) return

    runner.on(reporterEvent, (runnable) => {
      if (reporterEvent === 'hook end' && !runnable.title.startsWith('"before each" hook')) return

      throw new Error('custom reusable Mocha reporter failed')
    })
  }
}

const mocha = new Mocha({ reporter: ThrowOnceReporter })
mocha.cleanReferencesAfterRun?.(false)
if (process.env.MOCHA_REUSABLE_NATIVE_RETRY) mocha.retries(1)
mocha.addFile(require.resolve('./mocha-plugin-tests/reporter-reusable-run.js'))

function runAgainWhenReady () {
  if (hasStartedSecondRun || !firstRunFinished || (reporterEvent && !firstRunError)) return

  hasStartedSecondRun = true
  if (firstRunError) {
    // eslint-disable-next-line no-console
    console.log(`MOCHA FIRST RUN ERROR: ${firstRunError.message}`)
  }
  mocha.run((failures) => {
    // eslint-disable-next-line no-console
    console.log(`MOCHA SECOND RUN FAILURES: ${failures}`)
    process.exitCode = failures ? 1 : 0
  })
}

process.once('uncaughtException', (error) => {
  if (runCallbackThrows) {
    // eslint-disable-next-line no-console
    console.log(`MOCHA PROPAGATED ERROR: ${error.message}`)
    process.exitCode = 1
    return
  }

  firstRunError = error
  runAgainWhenReady()
})

mocha.run(() => {
  if (runCallbackThrows) {
    // eslint-disable-next-line no-console
    console.log('MOCHA RUN CALLBACK EXECUTED')
    throw new Error('custom reusable Mocha run callback failed')
  }

  firstRunFinished = true
  runAgainWhenReady()
})
