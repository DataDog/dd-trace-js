'use strict'

require('dd-trace/init')
// @ts-expect-error This code is running in a sandbox where fastify is available
const Fastify = require('fastify')

const fastify = Fastify({ logger: { level: 'error' } })

fastify.get('/foo/:name', function fooHandler (request) {
  return { hello: request.params.name } // BREAKPOINT: /foo/bar
})

fastify.get('/bar/:name', function barHandler (request) {
  return { hello: request.params.name } // BREAKPOINT: /bar/baz
})

fastify.listen({ port: process.env.APP_PORT || 0 }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  process.send?.({ port: fastify.server.address().port })
})
