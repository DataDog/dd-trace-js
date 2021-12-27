'use strict'

const { port, reqs } = require('./common')

const http = require('http')
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
  headers: {},
  port,
  path: '/'
}

if (Number(process.env.ATTACK_UA)) {
  Object.assign(opts.headers, {
    'user-agent': 'Arachni/v1'
  })
}

if (Number(process.env.ATTACK_404)) {
  opts.path += '../../../secret.txt'
}

if (Number(process.env.ATTACK_QS)) {
  opts.path += '?k=<script>alert()</script>'
}

request(opts)
