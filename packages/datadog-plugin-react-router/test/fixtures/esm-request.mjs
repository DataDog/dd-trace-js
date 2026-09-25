import { once } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const [tracerPath, registerPath, agentPort] = process.argv.slice(2)
const tracer = require(tracerPath).init({
  flushInterval: 0,
  plugins: false,
  service: 'test',
  url: `http://127.0.0.1:${agentPort}`,
})
tracer.use('http', { client: false })
tracer.use('react-router', {})
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
  const result = await handleRequest(new Request(`http://localhost${request.url}`))
  response.writeHead(result.status, Object.fromEntries(result.headers))
  response.end(await result.text())
}

const server = createServer(onRequest)
server.listen(0, '127.0.0.1')
await once(server, 'listening')
try {
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  const response = await fetch(`http://127.0.0.1:${address.port}/users/123`)
  process.stdout.write(JSON.stringify({ status: response.status, body: await response.text() }))
} finally {
  const closed = once(server, 'close')
  server.close()
  await closed
}
