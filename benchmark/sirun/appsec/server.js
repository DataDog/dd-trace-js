'use strict'

// AppSec is enabled from env config
require('../../..').init()

const { port, reqs } = require('./common')

const http = require('http')

let connectionsMade = 0

const server = http.createServer((req, res) => {
  res.writeHead(404)
  res.end('Hello, World!')
  if (++connectionsMade === reqs) {
    server.close()
  }
})
server.listen(port)
