'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 0
})

const fastify = require('fastify')

const app = fastify()
const port = parseInt(process.env.APP_PORT) || 3000

app.get('/', (request, reply) => {
  reply.headers({
    'content-type': 'text/plain',
    'content-language': 'en-US',
    'content-length': '3'
  })
  return 'end'
})

app.listen({ port }, () => {
  process.send({ port })
})
