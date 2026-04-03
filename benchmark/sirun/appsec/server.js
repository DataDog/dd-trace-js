'use strict'

// AppSec is enabled from env config
require('../../..').init()

const http = require('http')
const { port, reqs } = require('./common')

let connectionsMade = 0

const server = http.createServer((req, res) => {
  res.writeHead(404)
  res.end('Hello, World!')
  if (++connectionsMade === reqs) {
    server.close()
  }
})
server.listen(port)
