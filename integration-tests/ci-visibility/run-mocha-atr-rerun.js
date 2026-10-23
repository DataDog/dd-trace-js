'use strict'

const tracer = require('dd-trace')
const Mocha = require('mocha')

let attempts = 0
const mocha = new Mocha({
  retries: Number(process.env.MOCHA_NATIVE_RETRIES),
  reporter: class {
    constructor (runner) {
      runner.on('test', () => { attempts++ })
    }
  },
})
mocha.cleanReferencesAfterRun(false)
mocha.addFile(require.resolve('./test-flaky-test-retries/dynamic-atr.js'))

mocha.run(() => {
  const firstRunAttempts = attempts
  attempts = 0
  tracer.use('mocha', false)
  mocha.run(() => {
    process.stdout.write(`RETRY_COUNTS ${JSON.stringify([firstRunAttempts, attempts])}\n`)
  })
})
