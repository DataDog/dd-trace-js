'use strict'

require('dd-trace/init')
const http = require('http')

const server = http.createServer((req, res) => {
  res.end('hello world') // BREAKPOINT: /
  setImmediate(() => {
    server.close()
  })
})

server.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: (/** @type {import('net').AddressInfo} */ (server.address())).port })
})
