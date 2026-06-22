'use strict'

require('dd-trace').init({
  logInjection: false,
})

const http = require('http')

const server = http.createServer((req, res) => {
  res.end('ok')
}).listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
