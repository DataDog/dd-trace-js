'use strict'

// @ts-expect-error This code is running in a sandbox where dd-trace is available
require('dd-trace/init')
const http = require('http')

const server = http.createServer((req, res) => {
  if (req.url === '/exit') {
    // Exiting on its own, instead of being killed, makes the tracer send its final telemetry
    res.end()
    setImmediate(() => {
      server.close()
    })
    return
  }
  res.end('hello world') // BREAKPOINT: /
})

server.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: (/** @type {import('net').AddressInfo} */ (server.address())).port })
})
