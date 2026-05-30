'use strict'

// Long-workload graphql bench. Runs QUERIES sequential queries per process
// (default 100) so the fixed startup cost doesn't dominate the measurement.
// See ./README.md.

if (process.env.WITH_TRACER) {
  const tracer = require('../../..').init()

  if (process.env.WITH_DEPTH) {
    tracer.use('graphql', { depth: Number(process.env.WITH_DEPTH) })
  } else if (process.env.WITH_DEPTH_AND_COLLAPSE) {
    const [depth, collapse] = process.env.WITH_DEPTH_AND_COLLAPSE.split(',')
    tracer.use('graphql', { depth: Number(depth), collapse: Number(collapse) > 0 })
  }
}

if (process.env.WITH_ASYNC_HOOKS) {
  const hook = { init () {} }

  require('async_hooks').createHook(hook).enable()
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

// Total queries per process. A large total keeps the fixed startup (tracer load
// plus graphql require) a small fraction of the run. Fire them in sequential
// waves and await each wave so the unresolved query promises and their result
// graphs do not accumulate; otherwise a few thousand in flight at once exhausts
// the heap. Live memory stays flat while QUERIES scales.
const QUERIES = process.env.QUERIES ? Number(process.env.QUERIES) : 500
const WAVE = 50

function runWave (remaining) {
  if (remaining <= 0) return
  const size = remaining < WAVE ? remaining : WAVE
  const batch = []
  for (let i = 0; i < size; i++) {
    batch.push(graphql.graphql({ schema, source, variableValues }))
  }
  Promise.all(batch).then(() => runWave(remaining - size))
}

runWave(QUERIES)
