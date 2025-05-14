'use strict'

require('dd-trace/init')
const { generateObjectWithJSONSizeLargerThan } = require(process.env.PATH_TO_UTILS)

const Fastify = require('fastify')

const fastify = Fastify({ logger: { level: 'error' } })

const TARGET_SIZE = 1024 * 1024 // 1MB

fastify.get('/:name', function handler (request) {
  // eslint-disable-next-line no-unused-vars
  const obj = generateObjectWithJSONSizeLargerThan(TARGET_SIZE)

  return { hello: request.params.name } // BREAKPOINT: /foo
})

fastify.listen({ port: process.env.APP_PORT }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  process.send({ port: process.env.APP_PORT })
})
