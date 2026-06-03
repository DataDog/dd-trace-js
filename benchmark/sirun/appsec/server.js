'use strict'

const assert = require('node:assert/strict')

// AppSec is enabled from env config.
const tracer = require('../../..').init()
// Fail loudly if the tracer did not load: a broken require would otherwise
// measure a plain server and silently "pass".
assert.equal(typeof tracer.startSpan, 'function', 'tracer did not initialize')

// eslint-disable-next-line import/order -- the tracer must load before http to instrument it
const http = require('http')
const { port, reqs } = require('./common')

let connectionsMade = 0

const server = http.createServer((req, res) => {
  res.writeHead(404)
  res.end('Hello, World!')
  if (++connectionsMade === reqs) {
    server.close()
  }
})
server.listen(port)
