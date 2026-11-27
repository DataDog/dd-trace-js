'use strict'

const assert = require('node:assert/strict')
const { dirname, join } = require('node:path')

const dc = require('dc-polyfill')
const { after, before, describe, it } = require('mocha')

const agent = require('../../../dd-trace/test/plugins/agent')
const assertSubscriptionDelivery = require('../helpers/subscription')

describe('GraphQL.js native execution entry points', () => {
  let graphql
  let tracer

  before(async () => {
    await agent.load('graphql')
    tracer = require('../../../dd-trace')
    graphql = process.env.GRAPHQL_NATIVE_TEST_FORMAT === 'esm'
      ? await import('graphql')
      : require(join(dirname(require.resolve('graphql')), 'index.js'))
    assert.strictEqual(typeof graphql.validateExecutionArgs, 'function')
  })

  after(() => agent.close())

  for (const [method, validated] of [
    ['executeSync', false],
    ['experimentalExecuteIncrementally', false],
    ['legacyExecuteIncrementally', false],
    ['executeRootSelectionSet', true],
    ['experimentalExecuteRootSelectionSet', true],
    ['legacyExecuteRootSelectionSet', true],
  ]) {
    it(`traces and checks a delegated ${method} call`, async () => {
      const schema = graphql.buildSchema('type Query { outer: String }')
      const target = graphql.buildSchema('type Query { inner(value: String): String }')
      const document = graphql.parse('{ inner(value: "delegated") }')
      const contextValue = Object.freeze({})
      const resolverCalls = []
      const iastValues = []
      let outerSpan
      let innerSpan
      target.getQueryType().getFields().inner.resolve = (source, args) => {
        innerSpan = tracer.scope().active()
        return args.value
      }
      schema.getQueryType().getFields().outer.resolve = () => {
        outerSpan = tracer.scope().active()
        const args = Object.freeze({ schema: target, document, contextValue })
        const input = validated ? Object.freeze(graphql.validateExecutionArgs(args)) : args
        return graphql[method](input).data.inner
      }
      const resolverChannel = dc.channel('datadog:graphql:resolver:start')
      const iastChannel = dc.channel('apm:graphql:resolve:start')
      const check = ({ info }) => resolverCalls.push(info.fieldName)
      const taint = ({ args }) => iastValues.push(args.value)
      resolverChannel.subscribe(check)
      iastChannel.subscribe(taint)
      try {
        const result = await graphql.execute({ schema, document: graphql.parse('{ outer }'), contextValue })
        assert.strictEqual(result.errors, undefined)
        assert.strictEqual(result.data.outer, 'delegated')
        assert.deepStrictEqual(resolverCalls, ['outer', 'inner'])
        assert.deepStrictEqual(iastValues, [undefined, 'delegated'])
        assert.strictEqual(innerSpan?.context().getTag('resource.name'), 'inner:String')
        assert.strictEqual(innerSpan.context().toTraceId(), outerSpan.context().toTraceId())
      } finally {
        iastChannel.unsubscribe(taint)
        resolverChannel.unsubscribe(check)
      }
    })
  }

  for (const asyncSetup of [false, true]) {
    const setup = asyncSetup ? 'asynchronous' : 'synchronous'
    it(`checks each GraphQL.js subscription delivery after ${setup} setup`, () => {
      return assertSubscriptionDelivery(graphql, graphql.execute, graphql.subscribe, asyncSetup)
    })
  }

  for (const method of ['experimentalExecuteIncrementally', 'legacyExecuteIncrementally']) {
    it(`checks deferred fields through ${method}`, async () => {
      const schema = graphql.buildSchema('type Query { immediate: String, delayed: String }')
      const document = graphql.parse('{ immediate ... @defer { delayed } }')
      const checkedFields = []
      let span
      let finish
      const delayed = new Promise(resolve => { finish = resolve })
      const resolverChannel = dc.channel('datadog:graphql:resolver:start')
      const check = ({ info }) => checkedFields.push(info.fieldName)
      resolverChannel.subscribe(check)
      try {
        const result = await graphql[method]({
          schema,
          document,
          fieldResolver (source, args, context, info) {
            if (info.fieldName === 'immediate') return 'now'
            span = tracer.scope().active()
            return delayed
          },
        })
        assert.strictEqual(result.initialResult.data.immediate, 'now')
        const payload = result.subsequentResults.next()
        finish('later')
        assert.strictEqual((await payload).value.incremental[0].data.delayed, 'later')
        assert.strictEqual((await result.subsequentResults.next()).done, true)
        assert.deepStrictEqual(checkedFields, ['immediate', 'delayed'])
        assert.strictEqual(span?.context().getTag('resource.name'), 'delayed:String')
      } finally {
        finish('later')
        resolverChannel.unsubscribe(check)
      }
    })
  }

  it('isolates concurrent executions of the same validated arguments', async () => {
    const schema = graphql.buildSchema('type Query { item: Item } type Item { value: String }')
    const document = graphql.parse('{ item { value } }')
    const finish = []
    const parentSpans = []
    const childSpans = []
    const finishedArgs = []
    const input = Object.freeze(graphql.validateExecutionArgs({
      schema,
      document,
      hooks: {
        asyncWorkFinished: ({ validatedExecutionArgs }) => finishedArgs.push(validatedExecutionArgs),
      },
      fieldResolver (source, args, contextValue, info) {
        const span = tracer.scope().active()
        if (info.fieldName === 'item') {
          const value = String(parentSpans.length)
          parentSpans.push(span)
          return new Promise(resolve => finish.push(() => resolve({ value })))
        }
        childSpans[Number(source.value)] = span
        return source.value
      },
    }))

    const results = Promise.all([graphql.executeRootSelectionSet(input), graphql.executeRootSelectionSet(input)])
    for (const resolve of finish) resolve()
    const [first, second] = await results
    assert.strictEqual(first.data.item.value, '0')
    assert.strictEqual(second.data.item.value, '1')
    assert.strictEqual(finishedArgs.length, 2)
    assert.strictEqual(finishedArgs[0], input)
    assert.strictEqual(finishedArgs[1], input)
    assert.deepStrictEqual(parentSpans.map(span => span?.context().getTag('resource.name')), ['item:Item', 'item:Item'])
    assert.deepStrictEqual(
      childSpans.map(span => span?.context().getTag('resource.name')),
      ['value:String', 'value:String']
    )
    assert.deepStrictEqual(
      childSpans.map(span => span?.context().toTraceId()),
      parentSpans.map(span => span?.context().toTraceId())
    )
    assert.notStrictEqual(parentSpans[0].context().toTraceId(), parentSpans[1].context().toTraceId())
  })

  it('preserves the native error for a non-callable default resolver', () => {
    const schema = graphql.buildSchema('type Query { value: String }')
    const args = graphql.validateExecutionArgs({
      schema,
      document: graphql.parse('{ value }'),
      fieldResolver: false,
    })

    tracer.use('graphql', { enabled: false })
    let native
    try {
      native = graphql.executeRootSelectionSet(args)
    } finally {
      tracer.use('graphql', { enabled: true })
    }

    const instrumented = graphql.executeRootSelectionSet(args)
    assert.deepStrictEqual(instrumented.data, native.data)
    assert.strictEqual(instrumented.errors.length, 1)
    assert.deepStrictEqual(instrumented.errors[0].path, ['value'])
    assert.ok(instrumented.errors[0].originalError instanceof TypeError)
    assert.strictEqual(instrumented.errors[0].message, native.errors[0].message)
  })
})
