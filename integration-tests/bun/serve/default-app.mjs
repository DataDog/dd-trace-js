import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('dd-trace').init({ startupLogs: false, flushInterval: 10 })
const { Hono } = require('hono')
const app = new Hono()
app.get('/users/:id', c => c.text(c.req.param('id')))
app.port = 0

// Observe the server that Bun starts from the default export, without starting it ourselves.
const serve = globalThis.Bun.serve
globalThis.Bun.serve = function (...args) {
  const server = serve.apply(this, args)
  process.send({ port: server.port })
  return server
}

export default app
