'use strict'

const assert = require('node:assert/strict')

const guard = require('../startup-guard')

const scenario = process.env.JIT_SCENARIO
const operations = Number(process.env.OPERATIONS)
// Full tracer load plus graphql-jit compilation is a legitimate fixed cost;
// keep enough loop work to hold it below 15% without pushing every variant past the runtime cap.
const maxStartupShare = 0.15

const tracer = require('../../..').init()
const processor = tracer._tracer._processor
/** @type {{ name: string }[] | undefined} */
let preflightTrace
processor._exporter = {
  /** @param {{ name: string }[]} trace */
  export (trace) {
    preflightTrace = trace
  },
}

const graphqlJitVersion = require('../../../versions/graphql-jit')
const graphql = graphqlJitVersion.get('graphql')
const { compileQuery } = graphqlJitVersion.get()
const { schema, sources } = require('./jit-schema')

const source = sources[scenario]
assert.ok(source, `unknown JIT benchmark scenario: ${scenario}`)
assert.ok(operations > 0, 'OPERATIONS must be positive')

const document = graphql.parse(source)
const compiled = compileQuery(schema, document)
assert.strictEqual(typeof compiled.query, 'function', 'graphql-jit did not compile the query')

const rootValue = {}
const contextValue = {}
const variableValues = {}

/**
 * @param {{ data?: Record<string, unknown>, errors?: unknown[] }} result
 * @returns {void}
 */
function assertResult (result) {
  assert.strictEqual(result.errors, undefined, 'graphql-jit returned errors')

  if (scenario === 'async') {
    assert.strictEqual(result.data?.asyncValue, 'async')
  } else {
    const items = result.data?.items
    assert.strictEqual(Array.isArray(items), true)
    assert.strictEqual(items.length, 20)
    assert.strictEqual(items[19].right, 'right')
  }
}

/**
 * @returns {void}
 */
function assertTracing () {
  const expectedResolveSpans = scenario === 'async' ? 1 : 3
  assert.strictEqual(
    preflightTrace?.filter(span => span.name === 'graphql.execute').length,
    1,
    'JIT benchmark did not produce one graphql.execute span'
  )
  assert.strictEqual(
    preflightTrace?.filter(span => span.name === 'graphql.resolve').length,
    expectedResolveSpans,
    'JIT benchmark did not produce the expected graphql.resolve spans'
  )

  // Keep the real trace processor and formatting work in the loop, but do not
  // buffer, encode, or send benchmark traces after the operation finishes.
  processor._exporter = { export () {} }
}

if (scenario === 'compile') {
  assertResult(compiled.query(rootValue, contextValue, variableValues))
  assertTracing()

  guard.loopStart()
  let result
  for (let i = 0; i < operations; i++) {
    result = compileQuery(schema, document)
  }
  guard.done(maxStartupShare)
  assert.strictEqual(typeof result.query, 'function')
} else if (scenario === 'async') {
  ;(async () => {
    assertResult(await compiled.query(rootValue, contextValue, variableValues))
    assertTracing()

    guard.loopStart()
    for (let i = 0; i < operations; i++) {
      await compiled.query(rootValue, contextValue, variableValues)
    }
    guard.done(maxStartupShare)
  })()
} else {
  assertResult(compiled.query(rootValue, contextValue, variableValues))
  assertTracing()

  guard.loopStart()
  for (let i = 0; i < operations; i++) {
    compiled.query(rootValue, contextValue, variableValues)
  }
  guard.done(maxStartupShare)
}
