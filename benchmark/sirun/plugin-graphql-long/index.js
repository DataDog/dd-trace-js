'use strict'

// Long-workload graphql bench. Runs a fixed number of sequential queries per
// process so tracer and graphql startup stay a small fraction of the run.

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const preflightTraces = []
const noopExporter = { export () {} }
let processor

if (process.env.WITH_TRACER) {
  const tracer = require('../../..').init()

  processor = tracer._tracer._processor
  processor._exporter = {
    /** @param {Array<Record<string, unknown>>} spans */
    export (spans) {
      preflightTraces.push(spans)
    },
  }

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

  if (processor) {
    validatePreflightTrace()
    processor._exporter = noopExporter
    preflightTraces.length = 0
  }

  guard.loopStart()
  for (let i = 0; i < OPERATIONS; i++) {
    await graphql.graphql({ schema, source, variableValues })
  }
  // Node 26 runs this loop ~2x faster than Node 20. Per-Node operation counts
  // keep the setup share below 10% without making slower releases overlong.
  guard.done(0.1)
})()

function validatePreflightTrace () {
  let executeFound = false
  let resolverCount = 0
  let collapsedPathFound = false
  let indexedPathFound = false

  for (const trace of preflightTraces) {
    for (const span of trace) {
      if (span.name === 'graphql.execute') {
        executeFound = true
      } else if (span.name === 'graphql.resolve') {
        resolverCount++
        const path = span.meta['graphql.field.path']
        collapsedPathFound ||= path.includes('.*.')
        indexedPathFound ||= /\.\d+\./.test(path)
      }
    }
  }

  assert.ok(executeFound, 'graphql.execute span was not exported')

  if (process.env.DEPTH === '0') {
    assert.equal(resolverCount, 0, 'depth-off exported resolver spans')
  } else {
    assert.ok(resolverCount > 0, 'depth-on exported no resolver spans')
    assert.equal(
      collapsedPathFound,
      process.env.COLLAPSE === '1',
      'resolver path collapse did not match the variant'
    )
    assert.equal(
      indexedPathFound,
      process.env.COLLAPSE === '0',
      'resolver path indexes did not match the variant'
    )
  }
}
