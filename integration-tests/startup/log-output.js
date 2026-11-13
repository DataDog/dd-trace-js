'use strict'

require('../..').init({ startupLogs: true, service: 'startup-log-example' })

const http = require('node:http')

const server = http.createServer(handleRequest)

server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => {
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  process.stdout.write(`Listening on http://127.0.0.1:${port}\n`)
})

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
function handleRequest (request, response) {
  process.stdout.write(`${request.method} ${request.url}\n`)
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ message: 'Hello from the startup log example' }))
}
