'use strict'

const runRequests = require('../http-client')
const { port, reqs, warmup } = require('./common')

const path = '/?param=value'
const opts = {
  headers: {
    accept: 'text/html',
  },
  host: '127.0.0.1',
  port,
  path,
}
runRequests(opts, warmup, reqs, 1)
