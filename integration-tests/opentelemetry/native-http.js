'use strict'

require('../..').init({ flushInterval: 0 })

const http = require('node:http')
const httpRequest = require('../../packages/dd-trace/test/setup/helpers/http-client')

const server = http.createServer((_request, response) => {
  response.statusCode = 201
  response.end('created')
})

server.listen(0, '127.0.0.1', async () => {
  try {
    const { port } = server.address()
    await httpRequest.get(`http://127.0.0.1:${port}/transport`)
  } finally {
    server.close()
  }
})
