'use strict'

const tracer = require('dd-trace')

tracer.init({
  startupLogs: false,
  url: process.env.DD_TRACE_AGENT_URL,
  flushInterval: 10,
})

const http = require('http')

const server = http.createServer((req, res) => {
  res.end('Hello World')
})

server.listen(0, () => {
  const address = /** @type {import('net').AddressInfo} */ (server.address())
  const url = `http://127.0.0.1:${address.port}`

  http.get(url, (res) => {
    res.on('data', () => {})
    res.on('end', () => {
      server.close(() => {
        setTimeout(() => {
          // eslint-disable-next-line no-console
          console.log('ok')
          process.exit(0)
        }, 300)
      })
    })
  })
})
