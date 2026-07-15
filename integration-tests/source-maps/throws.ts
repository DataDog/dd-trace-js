const http = require('node:http')
const tracer = require('dd-trace')

type Span = { setTag: (name: string, value: unknown) => unknown }

function getError (): Error {
  return new Error('boom from typescript')
}

const server = http.createServer((
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse
) => {
  const error = getError()
  if (request.url === '/stack') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ stack: error.stack }))
    return
  }

  tracer.trace('source-map.request', (span: Span) => {
    span.setTag('error', error)
  })
  response.statusCode = 500
  response.end()
})

server.listen(Number(process.env.APP_PORT) || 0, () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP server did not listen on a TCP port')
  process.send?.({ port: address.port })
})
