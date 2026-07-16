'use strict'

const assert = require('node:assert/strict')

if (Number(process.env.CLIENT_USE_TRACER)) {
  require('../../..').init()
}

const http = require('http')
const { port, reqs } = require('./common')

// Reuse a single keep-alive connection. Without it, a new TCP connection per
// request churns ephemeral ports on localhost and the per-request cost falls
// off a cliff well before the request count needed to dominate startup. One
// socket keeps requests strictly sequential (same shape as before) while
// removing the connection-setup noise. 127.0.0.1 avoids per-connection
// localhost -> ::1 lookups.
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

let path = '/'
if (Number(process.env.CLIENT_LONG_QUERYSTRING)) {
  path += '?' + 'token=secret&'.repeat(100) + 'a'.repeat(1500)
}

const options = { host: '127.0.0.1', port, path, agent }

let connectionsMade = 0
let checked = false

function request () {
  http.get(options, (res) => {
    let body = ''
    res.on('data', (chunk) => {
      if (!checked) {
        body += chunk
      }
    })
    res.on('end', () => {
      if (!checked) {
        // Fail loudly if the server stops responding as expected.
        assert.equal(body, 'Hello, World!', 'server did not return the expected body')
        checked = true
      }
      if (++connectionsMade !== reqs) {
        request()
      }
    })
  }).on('error', () => {
    setTimeout(request, 10)
  })
}

request()
