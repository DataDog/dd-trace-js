'use strict'

// @ts-expect-error This code runs in a sandbox where dd-trace is available.
require('dd-trace/init')
const http = require('node:http')

const server = http.createServer((req, res) => {
  res.end('hello world') // BREAKPOINT: /
})

process.once('SIGTERM', () => server.close())

server.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: (/** @type {import('node:net').AddressInfo} */ (server.address())).port })
})
