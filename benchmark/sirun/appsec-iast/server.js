'use strict'

const assert = require('node:assert/strict')

const guard = require('../startup-guard')
const clearTimeoutGuard = require('../timeout-guard')('appsec-iast server')

const express = require('../../../versions/express').get()
const cookieParser = require('../../../versions/cookie-parser').get()
const { port, reqs, warmup } = require('./common')

/**
 * @param {(request: import('express').Request) => void} [onRequest]
 */
module.exports = function startServer (onRequest) {
  const app = express()
  app.use(cookieParser())

  let requestsHandled = 0

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  function handleRequest (req, res) {
    onRequest?.(req)
    res.writeHead(200)
    res.end('Hello, World!')

    requestsHandled++
    if (requestsHandled === warmup) {
      guard.loopStart()
    } else if (requestsHandled === reqs + warmup) {
      server.close()
      process.nextTick(() => guard.done(0.1))
    }
  }

  app.get('/', handleRequest)

  const server = app.listen(port, () => {
    assert.ok(server.address(), 'appsec-iast server failed to bind')
  })
  server.once('close', clearTimeoutGuard)
}
