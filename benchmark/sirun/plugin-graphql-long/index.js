'use strict'

// Long-workload graphql bench. Runs a fixed number of sequential queries per
// process so tracer and graphql startup stay a small fraction of the run.

const assert = require('node:assert/strict')
const guard = require('../startup-guard')
require('../noop-request')

if (process.env.WITH_TRACER) {
  const tracer = require('../../..').init()

  const options = {}
  if (process.env.DEPTH) {
    options.depth = Number(process.env.DEPTH)
  }
  if (process.env.COLLAPSE) {
    options.collapse = process.env.COLLAPSE === '1'
  }
  tracer.use('graphql', options)
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

// Queries run sequentially. The resolvers return settled promises so the plugin
// follows its Promise path without making libuv scheduling the measured surface.
const OPERATIONS = Number(process.env.OPERATIONS)

;(async () => {
  const result = await graphql.graphql({ schema, source, variableValues })
  assert.ok(result.data && !result.errors, 'graphql query returned no data')

  guard.loopStart()
  for (let i = 0; i < OPERATIONS; i++) {
    await graphql.graphql({ schema, source, variableValues })
  }
  // Node 26 runs this loop ~2x faster than Node 20. Per-Node operation counts
  // keep the setup share below 10% without making slower releases overlong.
  guard.done(0.1)
})()
