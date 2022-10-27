'use strict'

const semver = require('semver')

// TODO: benchmark the tracer as well but for now it's just too slow
if (Number(process.env.WITH_TRACER)) {
  const tracer = require('../../..').init()

  // Note: depth must be an integer >= 0, and collapse either 0 or 1 (true or false)
  if (Number(process.env.WITH_DEPTH)) {
    tracer.use('graphql', { depth: Number(process.env.WITH_DEPTH) })
  } else if (process.env.WITH_DEPTH_AND_COLLAPSE) {
    const [depth, collapse] = process.env.WITH_DEPTH_AND_COLLAPSE.split(',')
    tracer.use('graphql', { depth: Number(depth), collapse: Number(collapse) > 0 })
  }
}

if (Number(process.env.WITH_ASYNC_HOOKS)) {
  const hook = semver.satisfies(process.versions.node, '>=14.5')
    ? { init () {} }
    : { init () {}, before () {}, after () {}, destroy () {} }

  require('async_hooks').createHook(hook).enable()
}

const graphql = require('../../../versions/graphql/node_modules/graphql')
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

for (let i = 0; i < 6; i++) {
  graphql.graphql({ schema, source, variableValues })
}
