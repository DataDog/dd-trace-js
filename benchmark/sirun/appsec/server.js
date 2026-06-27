'use strict'

const assert = require('node:assert/strict')

const guard = require('../startup-guard')
const clearTimeoutGuard = require('../timeout-guard')('appsec server')

require('../noop-request')

// AppSec is enabled from env config.
const tracer = require('../../..').init()
// Fail loudly if the tracer did not load: a broken require would otherwise
// measure a plain server and silently "pass".
assert.equal(typeof tracer.startSpan, 'function', 'tracer did not initialize')

// eslint-disable-next-line import/order -- the tracer must load before http to instrument it
const http = require('http')
const { port, reqs, warmup } = require('./common')

let connectionsMade = 0

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function handleRequest (req, res) {
  res.writeHead(404)
  res.end('Hello, World!')

  connectionsMade++
  if (connectionsMade === warmup) {
    guard.loopStart()
  } else if (connectionsMade === reqs + warmup) {
    guard.done(0.1)
    server.close()
  }
}

const server = http.createServer(handleRequest)
server.once('close', clearTimeoutGuard)
server.listen(port)
