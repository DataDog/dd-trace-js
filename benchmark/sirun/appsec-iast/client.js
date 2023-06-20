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
  }).on('error', (e) => {
    setTimeout(() => {
      request(opts)
    }, 10)
  })
}

const path = '/?param=value'
const opts = {
  headers: {
    accept: 'text/html'
  },
  port,
  path
}
request(opts)
