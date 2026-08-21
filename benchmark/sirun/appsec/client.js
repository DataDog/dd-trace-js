'use strict'

const runRequests = require('../http-client')
const { port, reqs, warmup } = require('./common')

// Keep enough requests in flight that client scheduling does not leave the
// measured server idle between responses.
const concurrency = 4

const opts = {
  host: '127.0.0.1',
  headers: {},
  port,
  path: '/',
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

runRequests(opts, warmup, reqs, concurrency)
