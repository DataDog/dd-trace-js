'use strict'

require('dd-trace/init')
const Fastify = require('fastify')

const fastify = Fastify()

fastify.get('/foo/:name', function fooHandler (request) {
  return { hello: request.params.name } // BREAKPOINT: /foo/bar
})

fastify.get('/bar/:name', function barHandler (request) {
  return { hello: request.params.name } // BREAKPOINT: /bar/baz
})

fastify.listen({ port: process.env.APP_PORT }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  process.send({ port: process.env.APP_PORT })
})
