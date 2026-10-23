// Built-ins are imported before the tracer so the bundle loads them before dd-trace installs its hooks.
import { lookup } from 'node:dns'
import { createServer, request } from 'node:http'

import './builtins-init.mjs'

const server = createServer((incoming, response) => {
  if (incoming.url === '/target') {
    response.end('builtin-ok')
    return
  }

  lookup('localhost', { family: 4 }, (error, address) => {
    if (error) {
      response.statusCode = 500
      response.end(String(error))
      return
    }
    // Use the IP address so the client request does not perform its own DNS lookup.
    const outgoing = request(`http://127.0.0.1:${server.address().port}/target`, (result) => {
      let body = ''
      result.setEncoding('utf8')
      result.on('data', (chunk) => { body += chunk })
      result.once('end', () => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ address, body }))
      })
    })
    outgoing.once('error', (error) => {
      response.statusCode = 500
      response.end(String(error))
    })
    outgoing.end()
  })
})

server.listen(0, () => {
  process.send?.({ port: server.address().port })
})
