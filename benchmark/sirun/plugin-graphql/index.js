'use strict'

// TODO: benchmark the tracer as well but for now it's just too slow
// if (Number(process.env.WITH_TRACER)) {
//   require('../../..').init().use('graphql', { depth: 0 })
// }

if (Number(process.env.WITH_ASYNC_HOOKS)) {
  const semver = require('semver')
  const hook = semver.satisfies(process.versions.node, '>=14.5 || ^12.19.0')
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

for (let i = 0; i < 1; i++) {
  graphql.graphql({ schema, source, variableValues })
}
