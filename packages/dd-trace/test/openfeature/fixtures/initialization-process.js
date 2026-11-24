'use strict'

// The tracer loads first so it can hook the SDK. Nothing but the tracer may keep this process alive, so how the
// process exits shows what the provider holds.
const tracer = require('../../../../..').init({ plugins: false })

// eslint-disable-next-line import/order
const { OpenFeature } = require('@openfeature/server-sdk')

// Creating the provider starts its configuration source.
const provider = tracer.openfeature

process.on('exit', code => {
  process.stdout.write(`exit ${code}\n`)
})

const mode = process.argv[2]

function wait () {
  OpenFeature.setProviderAndWait(provider).then(
    () => { process.stdout.write('ready\n') },
    error => {
      process.stdout.write(`rejected: ${error.message}\n`)
      process.exitCode = 1
    }
  )
}

if (mode === 'wait') {
  wait()
} else if (mode === 'wait-later') {
  // By then the first poll has failed and the source waits for its retry on an unref'd timer.
  setTimeout(wait, 500)
} else if (mode === 'close') {
  OpenFeature.setProvider(provider)
  OpenFeature.close()
}
