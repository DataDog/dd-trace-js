'use strict'

require('dd-trace/init')
const Fastify = require('fastify')

const fastify = Fastify({ logger: { level: 'error' } })

fastify.get('/', function () {
  /* eslint-disable no-unused-vars */
  const foo = 'a'
  const bar = 'b'
  const baz = 'c'
  const secret = 'shh!'
  const password = 'shh!'
  /* eslint-enable no-unused-vars */

  return { hello: 'world' } // BREAKPOINT: /
})

fastify.listen({ port: process.env.APP_PORT || 0 }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  process.send?.({ port: fastify.server.address().port })
})
