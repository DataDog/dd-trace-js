'use strict'

const assert = require('node:assert/strict')

const { after, before, describe, it } = require('mocha')

const { ERROR_MESSAGE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema } = require('./naming')

describe('GraphQL incremental execution', () => {
  withVersions('graphql', '@graphql-tools/executor', '>=0.0.14', version => {
    let execute
    let graphql
    let normalizedExecutor

    before(async () => {
      await agent.load('graphql')

      const executor = require(`../../../versions/@graphql-tools/executor@${version}`)
      graphql = executor.get('graphql')
      const implementation = executor.get()
      execute = implementation.execute
      normalizedExecutor = implementation.normalizedExecutor
    })

    after(() => agent.close())

    /**
     * @param {string} operationName
     */
    function createDeferredOperation (operationName) {
      let resolveDelayed
      let rejectDelayed
      const delayed = new Promise((resolve, reject) => {
        resolveDelayed = resolve
        rejectDelayed = reject
      })
      const schema = new graphql.GraphQLSchema({
        query: new graphql.GraphQLObjectType({
          name: `${operationName}Query`,
          fields: {
            immediate: {
              type: graphql.GraphQLString,
              resolve: () => 'now',
            },
            delayed: {
              type: graphql.GraphQLString,
              resolve: () => delayed,
            },
          },
        }),
      })
      const document = graphql.parse(`query ${operationName} { immediate ... @defer { delayed } }`)

      return {
        arguments: { schema, document },
        reject: rejectDelayed,
        resolve: () => resolveDelayed('later'),
      }
    }

    /**
     * @param {string} operationName
     * @param {(executeSpan: object, delayedSpan: object) => void} [assertSpans]
     */
    function assertDeferredTrace (operationName, assertSpans) {
      return agent.assertSomeTraces(traces => {
        const executeSpan = traces[0].find(span => span.name === expectedSchema.server.opName)
        const delayedSpan = traces[0].find(span => span.resource === 'delayed:String')

        assert.ok(executeSpan)
        assert.ok(delayedSpan)
        assert.strictEqual(delayedSpan.parent_id.toString(), executeSpan.span_id.toString())
        assertSpans?.(executeSpan, delayedSpan)
      }, { spanResourceMatch: new RegExp(operationName) })
    }

    it('keeps raw deferred resolvers in the execution trace until the final payload', async () => {
      const operationName = 'RawDeferred'
      const deferred = createDeferredOperation(operationName)
      const assertion = assertDeferredTrace(operationName, (executeSpan, delayedSpan) => {
        const executeEnd = BigInt(executeSpan.start) + BigInt(executeSpan.duration)
        const delayedEnd = BigInt(delayedSpan.start) + BigInt(delayedSpan.duration)
        assert.ok(delayedEnd <= executeEnd)
      })
      const result = await execute(deferred.arguments)

      assert.strictEqual(result.initialResult.data.immediate, 'now')
      deferred.resolve()
      const finalResult = await result.subsequentResults.next()
      assert.strictEqual(finalResult.value.incremental[0].data.delayed, 'later')
      assert.strictEqual(finalResult.value.hasNext, false)
      assert.strictEqual(finalResult.done, false)
      await assertion
    })

    it('keeps flattened deferred resolvers in the execution trace until the final payload', async () => {
      const operationName = 'FlattenedDeferred'
      const deferred = createDeferredOperation(operationName)
      const assertion = assertDeferredTrace(operationName)
      const results = await normalizedExecutor(deferred.arguments)

      const initialResult = await results.next()
      assert.strictEqual(initialResult.value.data.immediate, 'now')
      assert.strictEqual(initialResult.value.hasNext, true)
      assert.strictEqual(initialResult.done, false)
      deferred.resolve()
      const finalResult = await results.next()
      assert.strictEqual(finalResult.value.incremental[0].data.delayed, 'later')
      assert.strictEqual(finalResult.value.hasNext, false)
      assert.strictEqual(finalResult.done, false)
      await assertion
    })

    it('finishes once when a deferred iterator is cancelled repeatedly', async () => {
      const operationName = 'CancelledDeferred'
      const deferred = createDeferredOperation(operationName)
      let executeHookCalls = 0

      agent.reload('graphql', {
        hooks: {
          execute () { executeHookCalls++ },
        },
      })
      try {
        const assertion = assertDeferredTrace(operationName)
        const result = await execute(deferred.arguments)

        assert.deepStrictEqual(await result.subsequentResults.return(), { value: undefined, done: true })
        assert.deepStrictEqual(await result.subsequentResults.return(), { value: undefined, done: true })
        deferred.resolve()
        await assertion
        assert.strictEqual(executeHookCalls, 1)
      } finally {
        agent.reload('graphql')
      }
    })

    it('finishes uncollapsed deferred resolvers after cancellation', async () => {
      const operationName = 'CancelledUncollapsedDeferred'
      const deferred = createDeferredOperation(operationName)

      agent.reload('graphql', { collapse: false })
      try {
        const assertion = assertDeferredTrace(operationName)
        const result = await execute(deferred.arguments)

        assert.deepStrictEqual(await result.subsequentResults.return(), { value: undefined, done: true })
        deferred.resolve()
        await assertion
      } finally {
        agent.reload('graphql')
      }
    })

    it('tags iterator errors while deferred resolvers settle', async () => {
      const operationName = 'RejectedDeferredIterator'
      const deferred = createDeferredOperation(operationName)
      const expectedError = new Error('Iterator failed')
      const assertion = assertDeferredTrace(operationName, executeSpan => {
        assert.strictEqual(executeSpan.error, 1)
        assert.strictEqual(executeSpan.meta[ERROR_MESSAGE], expectedError.message)
      })
      const result = await execute(deferred.arguments)

      await assert.rejects(result.subsequentResults.throw(expectedError), expectedError)
      deferred.resolve()
      await assertion
    })

    it('tags errors from deferred payloads', async () => {
      const operationName = 'RejectedDeferred'
      const deferred = createDeferredOperation(operationName)
      const expectedError = new Error('Deferred resolver failed')
      const assertion = assertDeferredTrace(operationName, executeSpan => {
        assert.strictEqual(executeSpan.error, 1)
        assert.strictEqual(executeSpan.meta[ERROR_MESSAGE], expectedError.message)
      })
      const result = await execute(deferred.arguments)
      const finalResult = result.subsequentResults.next()

      deferred.reject(expectedError)
      await finalResult
      await assertion
    })

    if (version === '1') {
      it('keeps tracer state valid until deferred resolvers settle after async disposal', async () => {
        const operationName = 'DisposedDeferred'
        const deferred = createDeferredOperation(operationName)
        const assertion = assertDeferredTrace(operationName)
        const result = await execute(deferred.arguments)
        const asyncDispose = Symbol.asyncDispose ?? Symbol.for('asyncDispose')

        await result.subsequentResults[asyncDispose]()
        deferred.resolve()
        await assertion
      })
    }
  })
})
