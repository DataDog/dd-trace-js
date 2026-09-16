'use strict'

const tracer = require('dd-trace')

tracer.init({
  startupLogs: false,
  url: process.env.DD_TRACE_AGENT_URL,
  flushInterval: 10,
})

const http = require('node:http')

const finish = require('./finish')

const server = http.createServer((req, res) => {
  res.end('Hello World')
})

server.listen(0, () => {
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  const url = `http://127.0.0.1:${address.port}`

  http.get(url, (res) => {
    res.on('data', () => {})
    res.on('end', () => {
      server.close(finish)
    })
  })
})
