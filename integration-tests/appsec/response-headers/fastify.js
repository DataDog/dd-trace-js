'use strict'

const tracer = require('dd-trace')
tracer.init({ flushInterval: 0 })

const fastify = require('fastify')

const app = fastify()

app.get('/', (request, reply) => {
  reply.type('text/plain')
  return 'hello'
})

app.listen({ port: process.env.APP_PORT || 0 }, () => {
  process.send?.({ port: app.server.address().port })
})
