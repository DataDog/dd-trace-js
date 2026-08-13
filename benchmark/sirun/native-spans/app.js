'use strict'

// The one test app for the native-spans PoC, imported by the parity harness, the
// end-to-end sirun benchmark and the standalone debug script. Defined here once so
// none of the three drifts from the others.
//
// The tracer must already be initialised by the caller — each consumer decides
// whether it wants the baseline or `DD_TRACE_EXPERIMENTAL_NATIVE_SPANS=1`, and
// initialising here would take that choice away.

const express = require('express')

/**
 * @param {{ port?: number, tracer?: object, onRequest?: () => void }} [options]
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
function startApp ({ port = 0, tracer, onRequest } = {}) {
  const app = express()

  // One middleware rather than a `request` listener on the server, so the count runs
  // inside the traced request the same way a real handler would.
  if (onRequest) {
    app.use((request, response, next) => {
      onRequest()
      next()
    })
  }

  // Automatic `http` / `express` instrumentation only, no manual span calls: the
  // simplest possible case, and a check that the native path does not break plain
  // root-span capture when the handler never touches `Span` directly.
  app.get('/hello', (request, response) => {
    response.send('hello world')
  })

  app.get('/simple', (request, response) => {
    const span = tracer.startSpan('app.simple', { childOf: tracer.scope().active() })
    span.setTag('app.step', 'one')
    span.finish()
    response.send('simple')
  })

  // Several child spans with multiple tags each — the clustered shape identity
  // elision is designed for, since each span is touched repeatedly in a row.
  app.get('/busy', (request, response) => {
    const parent = tracer.scope().active()
    for (let index = 0; index < 5; index++) {
      const span = tracer.startSpan('app.busy', { childOf: parent })
      span.setTag('app.index', index)
      span.setTag('app.step', 'busy')
      span.setTag('span.kind', 'internal')
      span.setTag('app.attempts', index + 1)
      span.finish()
    }
    response.send('busy')
  })

  app.get('/error', (request, response, next) => {
    next(new Error('native-spans test failure'))
  })

  // Express's default handler prints the stack for every 500. `/error` is hit on
  // every pass, so without this the benchmark's own stderr write becomes part of what
  // is being measured.
  app.use((_error, request, response, _next) => {
    response.status(500).send('error')
  })

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise(resolve => server.close(() => resolve())),
      })
    })
    server.once('error', reject)
  })
}

const ROUTES = ['/hello', '/simple', '/busy', '/error']

module.exports = { ROUTES, startApp }
