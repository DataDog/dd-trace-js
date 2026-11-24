import assert from 'node:assert/strict'

import 'dd-trace/init.js'
import { trace } from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'

let started = false
let ended = false

const sdk = new NodeSDK({
  spanProcessors: [{
    onStart () { started = true },
    onEnd () { ended = true },
    forceFlush () { return Promise.resolve() },
    shutdown () { return Promise.resolve() },
  }],
})

sdk.start()

trace.getTracer('my-service-tracer').startActiveSpan('otel-sub', otelSpan => {
  setImmediate(() => {
    otelSpan.end()
    assert.strictEqual(started, true)
    assert.strictEqual(ended, true)
  })
})
