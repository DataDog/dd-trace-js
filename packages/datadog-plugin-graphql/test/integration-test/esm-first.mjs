import tracer from 'dd-trace'

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const outcome = process.env.OUTCOME
const executionResults = []
let variableFilterCalls = 0

if (outcome === 'auto' || outcome === 'package-disabled') {
  tracer.init()
} else {
  tracer.init({ plugins: false })
  const config = { enabled: outcome !== 'disabled', source: true }
  if (outcome === 'reentrant') {
    config.hooks = { execute: (_span, _args, result) => executionResults.push(result.data.echo) }
  }
  if (outcome === 'variable-filter') {
    config.variables = () => {
      variableFilterCalls++
      throw new Error('variables filter unavailable')
    }
  }
  tracer.use('graphql', config)
}

const require = createRequire(import.meta.url)
if (outcome === 'package-disabled') require('graphql-jit')

let graphql
if (outcome !== 'subpaths') {
  graphql = process.env.LOAD_MODE === 'require' ? require('graphql') : await import('graphql')
  assert.equal(graphql.version, process.env.GRAPHQL_VERSION)
}

await tracer.trace('test.graphql', async () => {
  if (outcome === 'reentrant') {
    runReentrantQuery(graphql)
    return
  }
  if (outcome === 'incremental') {
    runIncrementalQuery(graphql)
    return
  }
  if (outcome === 'subpaths') {
    runSubpathQueries()
    return
  }

  const schema = graphql.buildSchema('type Query { hello(name: String): String }')
  const document = graphql.parse('query Hello { greeting: hello(name: "world") }')
  assert.deepEqual(graphql.validate(schema, document), [])

  if (process.env.OUTCOME === 'phase-errors') {
    assert.throws(() => graphql.parse('query {'), { message: 'Syntax Error: Expected Name, found <EOF>.' })
    assert.throws(() => graphql.validate(schema, document, [() => {
      throw new Error('validation failed')
    }]), { message: 'validation failed' })
  }

  const executeSync = process.env.EXECUTE_SYNC === 'true'
  const execute = executeSync ? graphql.executeSync : graphql.execute
  let hello = ({ name }) => name
  if (process.env.OUTCOME === 'error') {
    const fail = () => { throw new Error('resolver failed') }
    hello = executeSync ? fail : async () => fail()
  } else if (process.env.OUTCOME === 'thenable') {
    hello = ({ name }) => ({
      then (resolve) {
        queueMicrotask(() => resolve(name))
      },
    })
  }

  const args = { schema, document, rootValue: { hello } }
  if (outcome === 'variable-filter') args.variableValues = { name: 'world' }
  let reads = 0
  if (process.env.OUTCOME === 'getter') {
    Object.defineProperty(args, 'variableValues', {
      get () {
        reads++
        return {}
      },
    })
  }
  const result = await execute(args)
  if (outcome === 'variable-filter') assert.equal(variableFilterCalls, 1)
  if (process.env.OUTCOME === 'getter') assert.equal(reads, 1)

  if (process.env.OUTCOME === 'error') {
    assert.equal(result.errors[0].message, 'resolver failed')
    assert.equal(result.data.greeting, null)
  } else {
    assert.equal(result.data.greeting, 'world')
    assert.equal(result.errors, undefined)
  }
})

/** @param {typeof import('graphql')} graphql */
function runReentrantQuery (graphql) {
  let nested = false
  const input = new graphql.GraphQLScalarType({
    name: 'Input',
    serialize: String,
    coerceInputValue () {
      if (nested) return 'inner'
      nested = true
      const result = graphql.executeSync(args)
      nested = false
      assert.equal(result.data.echo, 'inner')
      return 'outer'
    },
  })
  const schema = new graphql.GraphQLSchema({
    query: new graphql.GraphQLObjectType({
      name: 'Query',
      fields: {
        echo: {
          type: graphql.GraphQLString,
          args: { value: { type: input } },
          resolve: (_root, { value }) => value,
        },
      },
    }),
  })
  const document = graphql.parse('query Echo($value: Input) { echo(value: $value) }')
  const args = { schema, document, variableValues: { value: 'shared' } }
  assert.equal(graphql.execute(args).data.echo, 'outer')
  assert.deepEqual(executionResults, ['inner', 'outer'])
}

/** @param {typeof import('graphql')} graphql */
function runIncrementalQuery (graphql) {
  const schema = new graphql.GraphQLSchema({
    query: new graphql.GraphQLObjectType({
      name: 'Query',
      fields: { hello: { type: graphql.GraphQLString } },
    }),
    directives: [...graphql.specifiedDirectives, graphql.GraphQLDeferDirective],
  })
  const document = graphql.parse('{ hello ... @defer { greeting: hello } }')
  assert.throws(() => graphql.executeSync({ schema, document, rootValue: { hello: 'world' } }), {
    message: 'GraphQL execution failed to complete synchronously.',
  })
}

function runSubpathQueries () {
  const { execute } = require('graphql/execution')
  const { parse } = require('graphql/language')
  const { buildSchema } = require('graphql/utilities')
  const schema = buildSchema('type Query { hello(name: String): String }')
  const rootValue = { hello: ({ name }) => name }
  const document = parse('query Subpath { hello(name: "world") }')
  assert.equal(execute({ schema, document, rootValue }).data.hello, 'world')

  const graphql = require('graphql')
  const topLevelDocument = graphql.parse('query TopLevel { hello(name: "world") }')
  assert.equal(graphql.execute({ schema, document: topLevelDocument, rootValue }).data.hello, 'world')
}
