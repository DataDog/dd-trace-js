'use strict'

// Long-workload graphql bench. Runs QUERIES sequential queries per process
// (default 100) so the fixed startup cost doesn't dominate the measurement.
// See ./README.md.

if (Number(process.env.WITH_TRACER)) {
  const tracer = require('../../..').init()

  if (Number(process.env.WITH_DEPTH)) {
    tracer.use('graphql', { depth: Number(process.env.WITH_DEPTH) })
  } else if (process.env.WITH_DEPTH_AND_COLLAPSE) {
    const [depth, collapse] = process.env.WITH_DEPTH_AND_COLLAPSE.split(',')
    tracer.use('graphql', { depth: Number(depth), collapse: Number(collapse) > 0 })
  }
}

if (Number(process.env.WITH_ASYNC_HOOKS)) {
  const hook = { init () {} }

  require('async_hooks').createHook(hook).enable()
}

const graphql = require('../../../versions/graphql').get()
const schema = require('../plugin-graphql/schema')

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

const queries = Number(process.env.QUERIES || 150)
for (let i = 0; i < queries; i++) {
  graphql.graphql({ schema, source, variableValues })
}
