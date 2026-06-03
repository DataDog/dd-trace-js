'use strict'

const assert = require('node:assert/strict')
const http = require('http')

const loadInsecureBank = require('../load-insecure-bank')
const { port } = require('./common')

const app = loadInsecureBank()
app.set('port', port)
const server = http.createServer(app)

// Startup-time variant: bind, confirm the app loaded and bound, then close. The
// measured cost is the require + tracer/IAST init, not request handling.
server.listen(port, () => {
  assert.ok(server.address(), 'insecure-bank server failed to bind')
  server.close()
})
