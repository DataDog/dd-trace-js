'use strict'

// @ts-expect-error This code is running in a sandbox where dd-trace is available
require('dd-trace/init')
// @ts-expect-error This code is running in a sandbox where fastify is available
const Fastify = require('fastify')
const {
  LARGE_OBJECT_SKIP_THRESHOLD,
  // @ts-expect-error This code is running in a sandbox where dd-trace is available
} = require('dd-trace/packages/dd-trace/src/debugger/devtools_client/snapshot/constants')

const fastify = Fastify({ logger: { level: 'error' } })

fastify.get('/object-over-safety-threshold', function handler () {
  // Just over the threshold at which the collector gives up on capturing snapshots at this location for good
  const huge = Object.fromEntries(Array.from({ length: LARGE_OBJECT_SKIP_THRESHOLD + 1 }, (_, i) => [`p${i}`, i]))
  return { size: Object.keys(huge).length } // BREAKPOINT: /object-over-safety-threshold
})

fastify.listen({ port: process.env.APP_PORT || 0 }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  process.send?.({ port: fastify.server.address().port })
})
