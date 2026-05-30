'use strict'

// Long-workload graphql bench. Runs QUERIES queries per process (default 1500)
// so the fixed startup cost (tracer load plus graphql require) stays a small
// fraction of the run.

const assert = require('node:assert/strict')

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

// Total queries per process. A large total keeps the fixed startup a small
// fraction of the run. CONCURRENCY queries are kept in flight at once, which is
// how a real server runs graphql (several requests resolving in parallel)
// rather than one strictly after another. The fixed-size pool refills on each
// completion, so at most CONCURRENCY result graphs are live: memory stays flat
// regardless of QUERIES, the run cannot OOM, and there is no unbounded fan-out
// to inflate the variance.
const QUERIES = process.env.QUERIES ? Number(process.env.QUERIES) : 1500
const CONCURRENCY = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : 5

let started = 0
let checked = false

function runOne () {
  if (started >= QUERIES) return
  started++
  graphql.graphql({ schema, source, variableValues }).then((result) => {
    if (!checked) {
      // Fail loudly if the schema/resolvers stop producing a result: a broken
      // bench that silently returns errors would otherwise still "pass".
      assert.ok(result.data && !result.errors, 'graphql query returned no data')
      checked = true
    }
    runOne()
  })
}

for (let i = 0; i < CONCURRENCY; i++) {
  runOne()
}
