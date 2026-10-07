'use strict'

// @ts-expect-error This code is running in a sandbox where dd-trace is available
require('dd-trace/init')
// @ts-expect-error This code is running in a sandbox where dd-trace is available
const tracer = require('dd-trace')
const { setTimeout: sleep } = require('node:timers/promises')

// @ts-expect-error This code is running in a sandbox where fastify is available
const Fastify = require('fastify')

const fastify = Fastify({ logger: { level: 'error' } })

function first (value) {
  return value // BREAKPOINT: /chain
}

function second (value) {
  return value // BREAKPOINT: /second
}

function third (value) {
  return value // BREAKPOINT: /chain
}

function leaked () {
  return 'leaked' // BREAKPOINT: /leak
}

fastify.get('/chain', async function chainHandler () {
  first(1)
  await sleep(10)
  second(2)
  await sleep(10)
  third(3)
  return { traceId: getActiveTraceId() }
})

fastify.get('/second', function secondHandler () {
  second(2)
  return { traceId: getActiveTraceId() }
})

fastify.get('/loop', async function loopHandler () {
  let total = 0
  for (let i = 0; i < 3; i++) {
    total += i // BREAKPOINT: /loop
    await sleep(10)
  }
  return { traceId: getActiveTraceId(), total } // BREAKPOINT: /loop
})

fastify.get('/leak', function leakHandler () {
  // A timer created while handling the request runs its callbacks in the async context of the request, also after the
  // request and its trace have finished.
  setInterval(leaked, 20)
  return { traceId: getActiveTraceId() }
})

function getActiveTraceId () {
  return tracer.scope().active()?.context().toTraceId()
}

fastify.listen({ port: process.env.APP_PORT || 0 }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  process.send?.({ port: fastify.server.address().port })
})
