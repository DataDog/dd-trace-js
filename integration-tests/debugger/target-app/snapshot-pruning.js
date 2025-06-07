'use strict'

require('dd-trace/init')

const { randomBytes } = require('crypto')
const Fastify = require('fastify')

const fastify = Fastify({ logger: { level: 'error' } })

const TARGET_SIZE = 1024 * 1024 // 1MB
const LARGE_STRING = randomBytes(1024).toString('hex')

fastify.get('/:name', function handler (request) {
  // eslint-disable-next-line no-unused-vars
  const obj = generateObjectWithJSONSizeLargerThan1MB()

  return { hello: request.params.name } // BREAKPOINT: /foo
})

fastify.listen({ port: process.env.APP_PORT || 0 }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  process.send?.({ port: fastify.server.address().port })
})

function generateObjectWithJSONSizeLargerThan1MB () {
  const obj = {}
  let i = 0

  while (++i) {
    if (i % 100 === 0) {
      const size = JSON.stringify(obj).length
      if (size > TARGET_SIZE) break
    }
    obj[i] = LARGE_STRING
  }

  return obj
}
