'use strict'

const assert = require('node:assert/strict')

const { OpenFeature } = require('@openfeature/server-sdk')

// Nothing but the tracer may keep this process alive, so its exit shows what the provider holds.
const started = Date.now()
const tracer = require('../../../../..').init({ plugins: false })

process.on('exit', code => {
  process.stdout.write(`${JSON.stringify({ code, elapsedMs: Date.now() - started })}\n`)
})

if (process.argv[2] === 'wait') {
  OpenFeature.setProviderAndWait(tracer.openfeature).then(
    () => { process.stdout.write('ready\n') },
    error => {
      process.stdout.write(`rejected: ${error.message}\n`)
      process.exitCode = 1
    }
  )
} else {
  // The provider starts polling, but nothing initializes it.
  assert.ok(tracer.openfeature)
}
