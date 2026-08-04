'use strict'

const http = require('http')
const { port, reqs } = require('./common')

// Reuse a single keep-alive connection so a high request count does not churn
// ephemeral ports on localhost (which collapses throughput). 127.0.0.1 avoids
// per-connection localhost -> ::1 lookups.
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

let connectionsMade = 0

function request (opts) {
  http.get(opts, (res) => {
    res.on('data', () => {})
    res.on('end', () => {
      if (++connectionsMade !== reqs) {
        request(opts)
      }
    })
  }).on('error', () => {
    setTimeout(() => {
      request(opts)
    }, 10)
  })
}

const opts = {
  host: '127.0.0.1',
  headers: {},
  port,
  path: '/',
  agent,
}

if (Number(process.env.ATTACK_UA)) {
  Object.assign(opts.headers, {
    'user-agent': 'Arachni/v1',
  })
}

if (Number(process.env.ATTACK_404)) {
  opts.path += '../../../secret.txt'
}

if (Number(process.env.ATTACK_QS)) {
  opts.path += '?k=<script>alert()</script>'
}

request(opts)
