'use strict'

// Long-workload graphql bench. Runs OPERATIONS queries per process (default 1500)
// so the fixed startup cost (tracer load plus graphql require) stays a small
// fraction of the run.

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

if (process.env.WITH_TRACER) {
  const tracer = require('../../..').init()

  if (process.env.WITH_DEPTH) {
    tracer.use('graphql', { depth: Number(process.env.WITH_DEPTH) })
  } else if (process.env.WITH_DEPTH_AND_COLLAPSE) {
    const [depth, collapse] = process.env.WITH_DEPTH_AND_COLLAPSE.split(',')
    tracer.use('graphql', { depth: Number(depth), collapse: Number(collapse) > 0 })
  }
}

const graphql = require('../../../versions/graphql').get()
const schema = require('./schema')

const source = `
{
  friends {
    name
    address {
      civicNumber
      street
    }
    pets {
      type
      name
      owner {
        name
      }
    }
  }
}
`

const variableValues = { who: 'world' }

// Total queries per process, run sequentially. graphql here is CPU-bound
// (in-memory resolvers, nothing to overlap) and Node runs JS on one thread, so
// the sequential loop already saturates the core (~96% CPU, measured). Keeping
// several in flight only adds promise scheduling, live memory and GC, which made
// the run slower and noisier, never faster.
const OPERATIONS = Number(process.env.OPERATIONS)

let checked = false

guard.loopStart()
;(async () => {
  for (let i = 0; i < OPERATIONS; i++) {
    const result = await graphql.graphql({ schema, source, variableValues })
    if (!checked) {
      // Fail loudly if the schema/resolvers stop producing a result: a broken
      // bench that silently returns errors would otherwise still "pass".
      assert.ok(result.data && !result.errors, 'graphql query returned no data')
      checked = true
    }
  }
  // Node 26 runs this loop ~2x faster than Node 20, so the fixed tracer.init()
  // plus graphql-load setup is a larger share of the run there. Sizing OPERATIONS to
  // keep it under the default 7% would push the Node 20 run past ~110s, so allow 10%.
  guard.done(0.1)
})()
