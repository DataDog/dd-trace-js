'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 0
})

const fastify = require('fastify')
const app = fastify()

// Basic routes
app.get('/users', async (_, reply) => reply.send('ok'))
app.post('/users', async (_, reply) => reply.send('ok'))
app.put('/users/:id', async (_, reply) => reply.send('ok'))
app.delete('/users/:id', async (_, reply) => reply.send('ok'))
app.patch('/users/:id', async (_, reply) => reply.send('ok'))
app.options('/users', async (_, reply) => reply.send('ok'))

// Additional methods
app.trace('/trace-test', async (_, reply) => reply.send('ok'))
app.head('/head-test', async (_, reply) => reply.send('ok'))

// Using app.route()
app.route({
  method: ['POST'],
  url: '/multi-method',
  handler: async (_, reply) => reply.send('ok')
})

// Wildcard route
app.all('/wildcard', async (_, reply) => reply.send('ok'))

// Nested routes with Router
app.register(async function (router) {
  router.put('/nested/:id', async (_, reply) => reply.send('ok'))
}, { prefix: '/v1' })

// Deeply nested routes
app.register(async function (router) {
  router.register(async function (subRouter) {
    subRouter.get('/deep', async (_, reply) => reply.send('ok'))
    subRouter.post('/deep/:id', async (_, reply) => reply.send('ok'))
  }, { prefix: '/sub' })
}, { prefix: '/api' })

const start = async () => {
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = app.server.address().port
  process.send({ port })
}

start()
