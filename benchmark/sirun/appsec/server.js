'use strict'

const assert = require('node:assert/strict')

const guard = require('../startup-guard')
const clearTimeoutGuard = require('../timeout-guard')('appsec server')
const assertReplayValidated = require('./mock-native-appsec')

require('../noop-request')

// AppSec is enabled from env config.
// eslint-disable-next-line import/order -- the request and WAF mocks must load before tracer initialization
const tracer = require('../../..').init()
// Fail loudly if the tracer did not load: a broken require would otherwise
// measure a plain server and silently "pass".
assert.equal(typeof tracer.startSpan, 'function', 'tracer did not initialize')

// eslint-disable-next-line import/order -- the tracer must load before http to instrument it
const http = require('http')
const { port, reqs, warmup } = require('./common')

let responsesFinished = 0

function onResponseFinish () {
  responsesFinished++
  if (responsesFinished === warmup) {
    assertReplayValidated()
    guard.loopStart()
  } else if (responsesFinished === reqs + warmup) {
    guard.done(0.1)
    server.close()
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function handleRequest (req, res) {
  res.once('finish', onResponseFinish)
  res.writeHead(404)
  res.end('Hello, World!')
}

const server = http.createServer(handleRequest)
server.once('close', clearTimeoutGuard)
server.listen(port)
