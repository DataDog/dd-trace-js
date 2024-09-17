'use strict'

require('dd-trace/init')
const Fastify = require('fastify')

const fastify = Fastify()

fastify.get('/:name', function handler (request) {
  return { hello: request.params.name }
})

fastify.listen({ port: process.env.APP_PORT }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  process.send({ port: process.env.APP_PORT })
})
