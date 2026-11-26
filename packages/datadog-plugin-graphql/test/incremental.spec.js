'use strict'

const assert = require('node:assert/strict')
const { AsyncResource } = require('node:async_hooks')
const { setImmediate: immediate } = require('node:timers/promises')

const dc = require('dc-polyfill')
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

    for (const prewarm of [false, true]) {
      const schemaState = prewarm ? 'a warmed schema' : 'a cold schema'
      it(`checks every resolver when delegating to ${schemaState} with a shared context`, async () => {
        const tracer = require('../../dd-trace')
        const innerSchema = graphql.buildSchema('type Query { inner: String, fail: String }')
        const invalidSchema = new graphql.GraphQLSchema({})
        const innerDocument = graphql.parse('query Inner { inner outer: fail }')
        const delegatedError = new Error('Delegated resolver failed')
        const sharedContext = Object.freeze({})
        const invalidArgs = {
          schema: invalidSchema,
          document: graphql.parse('query Invalid { missing }'),
          contextValue: sharedContext,
        }
        const resolverArgs = []
        const rootValue = {
          inner (args) {
            resolverArgs.push(args)
            return tracer.trace('delegated.child', () => 'inner-value')
          },
          fail (args) {
            resolverArgs.push(args)
            assert.throws(() => normalizedExecutor(invalidArgs), {
              message: 'Query root type must be provided.',
            })
            throw delegatedError
          },
        }
        if (prewarm) {
          const fields = innerSchema.getQueryType().getFields()
          fields.inner.resolve = (source, args) => rootValue.inner(args)
          fields.fail.resolve = (source, args) => rootValue.fail(args)
          const warmup = await execute({ schema: innerSchema, document: graphql.parse('{ inner }') })
          assert.strictEqual(warmup.data?.inner, 'inner-value')
          resolverArgs.length = 0
        }

        const schema = graphql.buildSchema('type Query { outer: String }')
        schema.getQueryType().getFields().outer.resolve = (source, args, contextValue) => {
          resolverArgs.push(args)
          const result = execute({ schema: innerSchema, document: innerDocument, rootValue, contextValue })
          assert.strictEqual(result.errors?.[0].originalError, delegatedError)
          return result.data.inner
        }

        const assertion = agent.assertSomeTraces(([trace]) => {
          const resolver = trace.find(span => span.resource === 'outer:String')
          const delegated = trace.find(span => span.meta['graphql.operation.name'] === 'Inner')
          const inner = trace.find(span => span.resource === 'inner:String')
          const fail = trace.find(span => span.resource === 'fail:String')
          const child = trace.find(span => span.name === 'delegated.child')
          assert.ok(resolver)
          assert.strictEqual(resolver.meta[ERROR_MESSAGE], undefined)
          assert.strictEqual(resolver.error, 0)
          assert.ok(delegated)
          assert.strictEqual(delegated.name, expectedSchema.server.opName)
          assert.strictEqual(
            trace.filter(span => span.meta['graphql.operation.name'] === 'Delegated').length,
            1
          )
          assert.strictEqual(delegated.parent_id.toString(), resolver.span_id.toString())
          assert.ok(inner)
          assert.strictEqual(inner.parent_id.toString(), delegated.span_id.toString())
          assert.ok(fail)
          assert.strictEqual(fail.parent_id.toString(), delegated.span_id.toString())
          assert.strictEqual(fail.meta[ERROR_MESSAGE], delegatedError.message)
          assert.ok(child)
          assert.strictEqual(child.parent_id.toString(), inner.span_id.toString())
        }, { spanResourceMatch: /Delegated/ })
        const document = graphql.parse('query Delegated { outer }')
        const checks = []
        const requestSources = []
        const resolverChannel = dc.channel('datadog:graphql:resolver:start')
        const iastChannel = dc.channel('apm:graphql:resolve:start')
        const iastArgs = []
        const recordCheck = ({ info, abortController, args }) => {
          checks.push({ field: info.fieldName, abortController, args })
        }
        const recordIastSource = ({ rootCtx, args }) => {
          requestSources.push(rootCtx.requestSource)
          iastArgs.push(args)
        }
        resolverChannel.subscribe(recordCheck)
        iastChannel.subscribe(recordIastSource)
        try {
          const [result] = await Promise.all([
            normalizedExecutor({ schema, document, contextValue: sharedContext }),
            assertion,
          ])
          assert.strictEqual(result.errors, undefined)
          assert.strictEqual(result.data.outer, 'inner-value')
        } finally {
          resolverChannel.unsubscribe(recordCheck)
          iastChannel.unsubscribe(recordIastSource)
        }

        assert.deepStrictEqual(checks.map(check => check.field), ['outer', 'inner', 'fail'])
        assert.strictEqual(resolverArgs.length, checks.length)
        for (const [index, check] of checks.entries()) {
          assert.strictEqual(check.args, resolverArgs[index])
          assert.strictEqual(iastArgs[index], resolverArgs[index])
          assert.deepStrictEqual(Object.keys(check.args), [])
        }
        assert.deepStrictEqual(requestSources, [undefined, 'query Delegated { outer }', 'query Delegated { outer }'])
        assert.ok(checks[0].abortController)
        assert.strictEqual(checks[1].abortController, checks[0].abortController)
        assert.strictEqual(checks[2].abortController, checks[0].abortController)
      })
    }

    for (const contextValue of [Object.freeze({}), () => ({})]) {
      it(`keeps overlapping resolver spans separate with a shared ${typeof contextValue} context`, async () => {
        const tracer = require('../../dd-trace')
        const schema = graphql.buildSchema('type Query { start: String, sibling: String, inner: String }')
        const fields = schema.getQueryType().getFields()
        const innerDocument = graphql.parse('query InnerOverlap { inner }')
        const document = graphql.parse('query OuterOverlap { start sibling }')
        let finishInner
        const pendingInner = new Promise(resolve => { finishInner = resolve })
        let innerResult
        fields.start.resolve = () => {
          innerResult = Promise.all([
            execute({ schema, document: innerDocument, contextValue }),
            execute({ schema, document: innerDocument, contextValue }),
          ])
          return 'started'
        }
        fields.inner.resolve = () => pendingInner
        fields.sibling.resolve = () => {
          finishInner('inner result')
          return 'sibling result'
        }

        const assertion = agent.assertSomeTraces(([trace]) => {
          const outer = trace.find(span => span.meta['graphql.operation.name'] === 'OuterOverlap')
          const inner = trace.filter(span => span.meta['graphql.operation.name'] === 'InnerOverlap')
          const sibling = trace.find(span => span.resource === 'sibling:String')
          assert.ok(outer)
          assert.strictEqual(inner.length, 2)
          assert.ok(sibling)
          assert.strictEqual(sibling.parent_id.toString(), outer.span_id.toString())
        }, { spanResourceMatch: /OuterOverlap/ })
        const outerResult = tracer.trace('overlap', () => execute({ schema, document, contextValue }))
        const [outer, inner] = await Promise.all([outerResult, innerResult, assertion])
        assert.strictEqual(outer.errors, undefined)
        assert.strictEqual(outer.data.sibling, 'sibling result')
        for (const result of inner) {
          assert.strictEqual(result.errors, undefined)
          assert.strictEqual(result.data.inner, 'inner result')
        }
      })
    }

    it('restores the resolver frame after a nested execution finishes', async () => {
      const tracer = require('../../dd-trace')
      const innerSchema = graphql.buildSchema('type Query { inner: String }')
      const innerDocument = graphql.parse('{ inner }')
      const schema = graphql.buildSchema('type Query { parent: Parent } type Parent { child: String }')
      const document = graphql.parse('{ parent { child } }')
      const contextValue = Object.freeze({})
      const resource = new AsyncResource('graphql-test', { requireManualDestroy: true })
      let resolverSpan
      schema.getQueryType().getFields().parent.resolve = (source, args, contextValue) => {
        assert.strictEqual(execute({
          schema: innerSchema,
          document: innerDocument,
          rootValue: { inner: 'inner result' },
          contextValue,
        }).data.inner, 'inner result')
        return Object.defineProperty({}, 'then', {
          value (onFulfilled, onRejected) {
            return Promise.resolve().then(() => resource.runInAsyncScope(onFulfilled, undefined, {})).catch(onRejected)
          },
        })
      }
      schema.getType('Parent').getFields().child.resolve = () => {
        resolverSpan = tracer.scope().active()
        return 'child result'
      }
      try {
        const result = await graphql.execute({ schema, document, contextValue })
        assert.strictEqual(result.errors, undefined)
        assert.strictEqual(result.data.parent.child, 'child result')
        assert.strictEqual(resolverSpan?.context().getTag('resource.name'), 'child:String')
      } finally {
        resource.emitDestroy()
      }
    })

    for (const scope of ['no execution scope', 'a different context', 'another execution with the same context']) {
      const useForeignScope = scope !== 'no execution scope'
      it(`keeps a detached resolver on its execution in ${scope}`, async () => {
        const tracer = require('../../dd-trace')
        const schema = graphql.buildSchema(
          'type Query { node: Item, waiting: String, foreign: String } type Item { value: String }'
        )
        const contextValue = Object.freeze({})
        let resource
        let foreignSpan
        let nodeSpan
        let finishWaiting
        const waiting = new Promise(resolve => { finishWaiting = resolve })
        const fields = schema.getQueryType().getFields()
        fields.waiting.resolve = () => waiting
        fields.foreign.resolve = () => {
          resource = new AsyncResource('graphql-test', { requireManualDestroy: true })
          foreignSpan = tracer.scope().active()
          return waiting
        }
        fields.node.resolve = () => {
          nodeSpan = tracer.scope().active()
          return Object.defineProperty({}, 'then', {
            value (onFulfilled, onRejected) {
              return Promise.resolve().then(() => {
                try {
                  return resource.runInAsyncScope(onFulfilled, undefined, {})
                } finally {
                  finishWaiting('waited')
                }
              }).catch(onRejected)
            },
          })
        }
        const activeSpans = []
        schema.getType('Item').getFields().value.resolve = () => {
          activeSpans.push(tracer.scope().active())
          return 'value'
        }

        const checks = []
        const channel = dc.channel('datadog:graphql:resolver:start')
        const record = ({ info, abortController }) => {
          if (info.fieldName === 'node' || info.fieldName === 'value') {
            checks.push([abortController, tracer.scope().active()?.context().toTraceId()])
          }
        }
        channel.subscribe(record)
        try {
          let foreignResult
          if (useForeignScope) {
            foreignResult = graphql.execute({
              schema,
              document: graphql.parse('{ foreign }'),
              contextValue: scope === 'a different context' ? Object.freeze({}) : contextValue,
            })
          } else {
            resource = new AsyncResource('graphql-test', { requireManualDestroy: true })
          }
          const [sibling, result, foreign] = await Promise.all([
            graphql.execute({ schema, document: graphql.parse('{ waiting }'), contextValue }),
            graphql.execute({ schema, document: graphql.parse('{ node { value } }'), contextValue }),
            foreignResult,
          ])
          assert.strictEqual(sibling.data.waiting, 'waited')
          assert.strictEqual(result.errors, undefined)
          assert.strictEqual(result.data.node.value, 'value')
          if (useForeignScope) {
            assert.ok(foreignSpan)
            assert.strictEqual(foreign.data.foreign, 'waited')
          }
          assert.strictEqual(activeSpans.length, 1)
          assert.ok(nodeSpan)
          assert.strictEqual(activeSpans[0]?.context().getTag('resource.name'), 'value:String')
          assert.strictEqual(activeSpans[0].context().toTraceId(), nodeSpan.context().toTraceId())
          assert.strictEqual(checks.length, 2)
          assert.ok(checks[0][0])
          assert.deepStrictEqual(checks[1], checks[0])
        } finally {
          channel.unsubscribe(record)
          finishWaiting('waited')
          resource?.emitDestroy()
        }
      })
    }

    for (const finishSibling of [false, true]) {
      const timing = finishSibling ? 'after' : 'before'
      it(`releases discarded incremental executions ${timing} the sibling finishes`, async function () {
        if (!global.gc) this.skip()

        const schema = graphql.buildSchema('type Query { immediate: String, delayed: String }')
        const document = graphql.parse('{ immediate ... @defer { delayed } }')
        const contextValue = Object.freeze({})
        const references = []
        const retainedVariables = []
        const channel = dc.channel('apm:graphql:resolve:start')
        const record = ({ rootCtx }) => {
          if (!references.some(reference => reference.deref() === rootCtx)) {
            references.push(new WeakRef(rootCtx))
          }
        }
        const run = args => {
          const resource = new AsyncResource('graphql-test', { requireManualDestroy: true })
          try {
            return resource.runInAsyncScope(execute, undefined, args)
          } finally {
            resource.emitDestroy()
          }
        }
        const cancel = () => {
          const controller = new AbortController()
          const abandoned = run({
            schema,
            document,
            rootValue: {
              immediate (args, contextValue, info) {
                retainedVariables.push(info.variableValues)
                return 'initial'
              },
              delayed: 'deferred',
            },
            contextValue,
            signal: controller.signal,
          })
          assert.strictEqual(abandoned.initialResult.data.immediate, 'initial')
          assert.ok(abandoned.subsequentResults)
          controller.abort()
        }
        let finishActive
        const active = new Promise(resolve => { finishActive = resolve })
        const activeArgs = {
          schema,
          document: graphql.parse('{ immediate }'),
          rootValue: { immediate: () => active },
          contextValue,
        }
        const activeResults = Promise.all(finishSibling ? [run(activeArgs)] : [run(activeArgs), run(activeArgs)])
        const collect = async () => {
          channel.subscribe(record)
          try {
            cancel()
            if (finishSibling) {
              finishActive('active')
              await activeResults
            } else {
              cancel()
            }
            assert.strictEqual(references.length, finishSibling ? 1 : 2)
            for (let index = 0; index < 5; index++) {
              await immediate()
              global.gc()
            }
            assert.ok(references.every(reference => reference.deref() === undefined))
            assert.strictEqual(retainedVariables.length, references.length)
          } finally {
            channel.unsubscribe(record)
            finishActive('active')
          }
        }

        const [, results] = await Promise.all([collect(), activeResults])
        for (const result of results) {
          assert.strictEqual(result.data.immediate, 'active')
        }
      })
    }

    it('records reused resolver errors from the GraphQL Tools executor', async () => {
      const operationName = 'ReusedResolverError'
      const error = new Error('GraphQL Tools resolver failed')
      const Item = new graphql.GraphQLObjectType({
        name: 'GraphQLToolsResolverErrorItem',
        fields: {
          value: {
            type: graphql.GraphQLString,
            /**
             * @param {{ error?: Error, value?: string }} source
             */
            resolve (source) {
              if (source.error) throw source.error
              return source.value
            },
          },
        },
      })
      const schema = new graphql.GraphQLSchema({
        query: new graphql.GraphQLObjectType({
          name: 'GraphQLToolsResolverErrorQuery',
          fields: {
            items: {
              type: new graphql.GraphQLList(Item),
              resolve: () => [{ value: 'first' }, { error }],
            },
          },
        }),
      })
      const document = graphql.parse(`query ${operationName} { items { value } }`)

      /** @param {Array<Array<object>>} traces */
      const assertTrace = traces => {
        let span
        for (const candidate of traces[0]) {
          if (candidate.meta?.['graphql.field.path'] === 'items.*.value') {
            span = candidate
            break
          }
        }

        assert.ok(span)
        assert.strictEqual(span.error, 1)
        assert.strictEqual(span.meta[ERROR_MESSAGE], error.message)
      }

      const [result] = await Promise.all([
        execute({ schema, document }),
        agent.assertSomeTraces(assertTrace, { spanResourceMatch: new RegExp(operationName) }),
      ])

      assert.strictEqual(result.data.items[0].value, 'first')
      assert.strictEqual(result.data.items[1].value, null)
      assert.strictEqual(result.errors.length, 1)
    })

    it('does not record a pre-located non-null error on its reused collapsed span', async () => {
      const operationName = 'PreLocatedNonNullResolverError'
      const error = Object.assign(new Error('pre-located non-null failure'), { path: ['foreign'] })
      const Item = new graphql.GraphQLObjectType({
        name: 'PreLocatedNonNullResolverErrorItem',
        fields: {
          value: {
            type: new graphql.GraphQLNonNull(graphql.GraphQLString),
            /** @param {{ error?: Error, value?: string }} source */
            resolve (source) {
              if (source.error) throw source.error
              return source.value
            },
          },
        },
      })
      const schema = new graphql.GraphQLSchema({
        query: new graphql.GraphQLObjectType({
          name: 'PreLocatedNonNullResolverErrorQuery',
          fields: {
            items: {
              type: new graphql.GraphQLList(Item),
              resolve: () => [{ value: 'first' }, { error }],
            },
          },
        }),
      })
      const document = graphql.parse(`query ${operationName} { items { value } }`)

      const [result] = await Promise.all([
        execute({ schema, document }),
        agent.assertSomeTraces(traces => {
          const span = traces[0].find(span => span.meta?.['graphql.field.path'] === 'items.*.value')

          assert.ok(span)
          assert.strictEqual(span.error, 0)
          assert.strictEqual(span.meta[ERROR_MESSAGE], undefined)
        }),
      ])

      assert.deepStrictEqual(result.errors[0].path, ['foreign'])
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
