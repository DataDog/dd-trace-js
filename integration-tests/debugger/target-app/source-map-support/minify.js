'use strict'

require('dd-trace/init')

const { createServer } = require('node:http')

const server = createServer((req, res) => {
  res.end('hello world') // BREAKPOINT: /
})

server.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})
