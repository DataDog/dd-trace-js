'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 0
})

const fastify = require('fastify')
const app = fastify()

// Basic routes
app.get('/users', async (_, reply) => reply.send('ok'))
app.post('/users/', async (_, reply) => reply.send('ok'))
app.put('/users/:id', async (_, reply) => reply.send('ok'))
app.delete('/users/:id', async (_, reply) => reply.send('ok'))
app.patch('/users/:id/:name', async (_, reply) => reply.send('ok'))
app.options('/users/:id?', async (_, reply) => reply.send('ok'))

// Route with regex
app.delete('/regex/:hour(^\\d{2})h:minute(^\\d{2})m', async (_, reply) => reply.send('ok'))

// Additional methods
app.trace('/trace-test', async (_, reply) => reply.send('ok'))
app.head('/head-test', async (_, reply) => reply.send('ok'))

// Custom method
app.addHttpMethod('MKCOL', { hasBody: true })
app.mkcol('/example/near/:lat-:lng/radius/:r', async (_, reply) => reply.send('ok'))

// Using app.route()
app.route({
  method: ['POST', 'PUT', 'PATCH'],
  url: '/multi-method',
  handler: async (_, reply) => reply.send('ok')
})

// All supported methods route
app.all('/all-methods', async (_, reply) => reply.send('ok'))

// Nested routes with Router
app.register(async function (router) {
  router.put('/nested/:id', async (_, reply) => reply.send('ok'))
}, { prefix: '/v1' })

// Deeply nested routes
app.register(async function (router) {
  router.get('/nested', async (_, reply) => reply.send('ok'))
  router.register(async function (subRouter) {
    subRouter.get('/deep', async (_, reply) => reply.send('ok'))
    subRouter.post('/deep/:id', async (_, reply) => reply.send('ok'))
  }, { prefix: '/sub' })
}, { prefix: '/api' })

// Wildcard routes
app.get('/wildcard/*', async (_, reply) => reply.send('ok'))
app.get('*', async (_, reply) => reply.send('ok'))

const start = async () => {
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = app.server.address().port
  process.send({ port })
}

setTimeout(() => {
  app.get('/later', async (_, reply) => reply.send('ok'))
  start()
}, 2e3)
