'use strict'

// The measured side: an untraced client driving the shared app's routes over one
// keep-alive connection, the same shape `plugin-http`'s client uses. The tracing cost
// under test lives in the server process, so it shows up here as request latency.

const assert = require('node:assert/strict')
const http = require('node:http')

const { ROUTES } = require('./app')
const { appPort, reqs } = require('./common')

// One keep-alive socket: a new TCP connection per request churns ephemeral ports on
// localhost and the per-request cost falls off a cliff long before the request count
// needed to dominate startup. 127.0.0.1 avoids per-connection localhost -> ::1 lookups.
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

let completed = 0
let bodySeen = false

function request () {
  const route = ROUTES[completed % ROUTES.length]

  http.get({ host: '127.0.0.1', port: appPort, path: route, agent }, response => {
    let body = ''
    response.on('data', chunk => {
      if (!bodySeen) body += chunk
    })
    response.on('end', () => {
      if (!bodySeen) {
        // Fail loudly if the server stops answering as expected.
        assert.equal(body, 'hello world', 'server did not return the expected body')
        bodySeen = true
      }
      if (++completed !== reqs) request()
    })
  }).on('error', () => {
    setTimeout(request, 10)
  })
}

request()
