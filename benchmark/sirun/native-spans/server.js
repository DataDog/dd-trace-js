'use strict'

// The traced side of the end-to-end benchmark. Exports to the capture server with
// decoding off — a discard-the-body sink — instead of a real agent, so the numbers
// are not polluted by network variance or agent availability in CI. This process is
// where the whole pipeline runs: the JS write path, synchronous decode / process /
// encode inside `flush()`, and the async HTTP PUT.

const { agentPort, appPort, reqs } = require('./common')

// Must precede the tracer require: the exporter reads the agent URL at construction,
// and `packages/dd-trace/src/index.js` picks the noop tracer when `DD_TRACE_ENABLED`
// is unset and an `OTEL_TRACES_EXPORTER` is configured. The protocol is left alone —
// both implementations follow `DD_TRACE_AGENT_PROTOCOL_VERSION`, so the two variants
// differ only in the span implementation.
process.env.DD_TRACE_AGENT_URL = `http://127.0.0.1:${agentPort}`
process.env.DD_TRACE_ENABLED = 'true'

const { startCaptureServer } = require('./capture-server')

async function main () {
  const sink = await startCaptureServer({ decode: false, port: agentPort })

  const tracer = require('../../../').init()
  const { startApp } = require('./app')

  // The client sends `reqs` requests and the server counts them, so the pair shuts
  // itself down without the harness having to signal it.
  let served = 0
  let shuttingDown = false

  const app = await startApp({
    tracer,
    port: appPort,
    onRequest: () => {
      if (++served === reqs) shutdown()
    },
  })

  function shutdown () {
    if (shuttingDown) return
    shuttingDown = true
    app.close().then(() => sink.close())
  }

  process.once('SIGTERM', shutdown)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
