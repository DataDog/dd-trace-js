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

fastify.get('/deeply-nested-large-object', function handler () {
  // The size of `obj` generated is carefully tuned to never result in a snapshot larger than the 1MB size limit, while
  // still being large enough to trigger the time budget limit. However, the size of `fastify` and `request` is not
  // stable across Node.js and Fastify versions, so the generated object might need to be adjusted.
  const obj = generateObject(5, 12) // eslint-disable-line no-unused-vars
  const start = process.hrtime.bigint()
  const diff = process.hrtime.bigint() - start // BREAKPOINT: /deeply-nested-large-object
  return { paused: Number(diff) / 1_000_000 }
})

fastify.get('/object-with-many-properties', function handler () {
  const obj = generateObject(0, 1_000_000) // eslint-disable-line no-unused-vars
  const start = process.hrtime.bigint()
  const diff = process.hrtime.bigint() - start // BREAKPOINT: /object-with-many-properties
  return { paused: Number(diff) / 1_000_000 }
})

fastify.get('/large-collections', function handler () {
  const arrOfPrimitives = Array.from({ length: 1_000_000 }, (_, i) => i) // eslint-disable-line no-unused-vars
  const arrOfObjects = Array.from({ length: 1_000_000 }, (_, i) => ({ i }))
  const map = new Map(arrOfObjects.map((obj, i) => [i, obj])) // eslint-disable-line no-unused-vars
  const set = new Set(arrOfObjects) // eslint-disable-line no-unused-vars
  const start = process.hrtime.bigint()
  const diff = process.hrtime.bigint() - start // BREAKPOINT: /large-collections
  return { paused: Number(diff) / 1_000_000 }
})

fastify.get('/large-collections-below-size-threshold', function handler () {
  // eslint-disable-next-line no-unused-vars
  const arrOfPrimitives = Array.from({ length: LARGE_OBJECT_SKIP_THRESHOLD - 1 }, (_, i) => i)
  const arrOfObjects = Array.from({ length: LARGE_OBJECT_SKIP_THRESHOLD - 1 }, (_, i) => ({ i }))
  const map = new Map(arrOfObjects.map((obj, i) => [i, obj])) // eslint-disable-line no-unused-vars
  const set = new Set(arrOfObjects) // eslint-disable-line no-unused-vars
  const start = process.hrtime.bigint()
  const diff = process.hrtime.bigint() - start // BREAKPOINT: /large-collections-below-size-threshold
  return { paused: Number(diff) / 1_000_000 }
})

fastify.listen({ port: process.env.APP_PORT || 0 }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  process.send?.({ port: fastify.server.address().port })
})

const leafValues = [null, undefined, true, 1, '']
const complexTypes = ['object', 'array', 'map', 'set']

/**
 * Generate a complex nested object that requires a lot of async CDP calls to traverse
 */
function generateObject (depth, breath) {
  const obj = {}
  for (let i = 0; i < breath; i++) {
    const key = `p${i}`
    if (depth === 0) {
      obj[key] = leafValues[i % leafValues.length]
    } else {
      const type = complexTypes[i % complexTypes.length]
      obj[key] = generateType(type, depth - 1, breath)
    }
  }
  return obj
}

function generateArray (depth, breath) {
  const arr = []
  for (let i = 0; i < breath; i++) {
    if (depth === 0) {
      arr.push(leafValues[i % leafValues.length])
    } else {
      const type = complexTypes[i % complexTypes.length]
      arr.push(generateType(type, depth - 1, breath))
    }
  }
  return arr
}

function generateMap (depth, breath) {
  const map = new Map()
  for (let i = 0; i < breath; i++) {
    if (depth === 0) {
      map.set(i, leafValues[i % leafValues.length])
    } else {
      const type = complexTypes[i % complexTypes.length]
      map.set(i, generateType(type, depth - 1, breath))
    }
  }
  return map
}

function generateSet (depth, breath) {
  const set = new Set()
  for (let i = 0; i < breath; i++) {
    if (depth === 0) {
      set.add(leafValues[i % leafValues.length])
    } else {
      const type = complexTypes[i % complexTypes.length]
      set.add(generateType(type, depth - 1, breath))
    }
  }
  return set
}

function generateType (type, depth, breath) {
  switch (type) {
    case 'object':
      return generateObject(depth, breath)
    case 'array':
      return generateArray(depth, breath)
    case 'map':
      return generateMap(depth, breath)
    case 'set':
      return generateSet(depth, breath)
  }
}
