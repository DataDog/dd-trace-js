'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 0,
})

const http = require('http')

const port = process.env.APP_PORT || 3000

const server = http.createServer((req, res) => {
  res.writeHead(200)
  res.end(JSON.stringify({ message: 'OK' }))
})

server.listen(port, () => {
  process.send({ port })
})
