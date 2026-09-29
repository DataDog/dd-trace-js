import { once } from 'node:events'
import { createRequire } from 'node:module'
import { takeCoverage } from 'node:v8'

const require = createRequire(import.meta.url)
const [tracerPath, registerPath, agentPort, host] = process.argv.slice(2)
const tracer = require(tracerPath).init({
  flushInterval: 0,
  plugins: false,
  service: 'test',
  url: `http://127.0.0.1:${agentPort}`,
})
tracer.use('http', { client: false })
tracer.use('react-router', {})
if (host === 'express') {
  tracer.use('express', { middleware: true })
  tracer.use('router', { middleware: true })
} else if (host === 'http2') {
  tracer.use('http2', {})
}
require(registerPath)

const { createServer } = await import('node:http')
// @ts-expect-error The test copies this fixture beside the selected react-router installation.
const { createRequestHandler } = await import('react-router')
const build = {
  basename: '/',
  future: { v8_middleware: false },
  ssr: true,
  prerender: [],
  routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
  routes: {
    root: { id: 'root', path: '/', module: { default () {} } },
    users: {
      id: 'users',
      parentId: 'root',
      path: 'users/:id',
      module: { default () {}, loader () { return 'user' } },
    },
  },
  assets: { version: 'test', routes: {} },
  entry: { module: { default: () => new Response('ok') } },
}
const handleRequest = createRequestHandler(build, 'test')

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
async function onRequest (request, response) {
  const run = async () => {
    const result = await handleRequest(new Request(`http://localhost${request.url}`))
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(await result.text())
  }
  return host === 'http2' ? tracer.trace('application.middleware', run) : run()
}

let server
if (host === 'express') {
  const { default: express } = await import('express')
  const app = express()
  app.all('/{*splat}', onRequest)
  server = createServer(app)
} else if (host === 'http2') {
  const { createServer: createHttp2Server } = await import('node:http2')
  server = createHttp2Server(onRequest)
} else {
  server = createServer(onRequest)
}
server.listen(0, '127.0.0.1')
await once(server, 'listening')
process.send('ready')
await once(process, 'message')
let client
let result
try {
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  if (host === 'http2') {
    const { connect } = await import('node:http2')
    client = connect(`http://127.0.0.1:${address.port}`)
    const stream = client.request({ ':path': '/users/123' })
    stream.end()
    const [headers] = await once(stream, 'response')
    let body = ''
    for await (const chunk of stream) body += chunk
    result = { status: headers[':status'], body }
  } else {
    const response = await fetch(`http://127.0.0.1:${address.port}/users/123`)
    result = { status: response.status, body: await response.text() }
  }
} finally {
  client?.close()
  const closed = once(server, 'close')
  server.close()
  await closed
}
if (process.env.NODE_V8_COVERAGE) takeCoverage()
process.send(result)
