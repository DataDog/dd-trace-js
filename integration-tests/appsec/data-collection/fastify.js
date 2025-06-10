'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 0
})

const fastify = require('fastify')
const app = fastify()

app.get('/', (request, reply) => {
  reply.headers({
    'content-type': 'text/plain',
    'content-language': 'en-US',
    'content-length': '3'
  })
  return 'end'
})

const port = process.env.APP_PORT ? Number(process.env.APP_PORT) : 0
app.listen({ port }, (err) => {
  process.send?.({ port: app.server.address().port })
})
