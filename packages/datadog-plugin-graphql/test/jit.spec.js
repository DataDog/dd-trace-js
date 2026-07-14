'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { after, before, describe, it } = require('mocha')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema } = require('./naming')

describe('Plugin', () => {
  describe('graphql-jit', () => {
    let graphql
    let compileQuery
    let schema

    /**
     * @param {unknown} _source
     * @param {{ name?: string }} args
     */
    function resolveHello (_source, { name }) {
      return name || 'world'
    }

    function buildSchema () {
      return new graphql.GraphQLSchema({
        query: new graphql.GraphQLObjectType({
          name: 'Query',
          fields: {
            hello: {
              type: graphql.GraphQLString,
              args: { name: { type: graphql.GraphQLString } },
              resolve: resolveHello,
            },
            defaultHello: { type: graphql.GraphQLString },
            slow: { type: graphql.GraphQLString, resolve: () => Promise.resolve('later') },
            boom: {
              type: graphql.GraphQLString,
              resolve: () => { throw new Error('resolver boom') },
            },
          },
        }),
      })
    }

    withVersions('graphql', 'graphql-jit', '>=0.7.0', version => {
      before(() => {
        return agent.load('graphql', { variables: ['name'] })
      })

      before(() => {
        // graphql-jit resolves its `graphql` peer up to the same instance this
        // require sees, so the schema and the compiler agree on graphql types.
        graphql = require('graphql')
        compileQuery = require(`../../../versions/graphql-jit@${version}`).get().compileQuery
        schema = buildSchema()
      })

      after(() => {
        return agent.close()
      })

      it('emits graphql.execute for a JIT-compiled query', async () => {
        const document = graphql.parse('query GetHello($name: String!) { hello(name: $name) }')
        const { query } = compileQuery(schema, document)

        const assertion = agent.assertSomeTraces(traces => {
          const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
          const resolve = traces[0].find(span => span.name === 'graphql.resolve')

          assertObjectContains(execute, {
            service: expectedSchema.server.serviceName,
            name: expectedSchema.server.opName,
            type: 'graphql',
            error: 0,
            meta: {
              'graphql.operation.type': 'query',
              'graphql.operation.name': 'GetHello',
              'graphql.variables.name': 'Ada',
              component: 'graphql',
              '_dd.integration': 'graphql',
            },
          })
          assert.match(execute.resource, /GetHello/)
          assertObjectContains(resolve, {
            name: 'graphql.resolve',
            resource: 'hello:String',
            meta: {
              'graphql.field.name': 'hello',
              'graphql.field.path': 'hello',
              'graphql.field.type': 'String',
            },
          })
          assert.strictEqual(resolve.parent_id.toString(), execute.span_id.toString())
        }, { spanResourceMatch: /GetHello/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, { name: 'Ada' }))(),
        ])
        assert.deepStrictEqual(result.data, { hello: 'Ada' })
      })

      it('traces a compiled default field resolver', async () => {
        const { query } = compileQuery(schema, graphql.parse('query DefaultHello { defaultHello }'))

        const assertion = agent.assertSomeTraces(traces => {
          const resolve = traces[0].find(span => span.name === 'graphql.resolve')
          assertObjectContains(resolve, {
            resource: 'defaultHello:String',
            meta: { 'graphql.field.name': 'defaultHello' },
          })
        }, { spanResourceMatch: /DefaultHello/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({ defaultHello: 'default world' }, {}, {}))(),
        ])
        assert.deepStrictEqual(result.data, { defaultHello: 'default world' })
      })

      it('traces every execution of a compiled query, not only the first', async () => {
        const { query } = compileQuery(schema, graphql.parse('query Repeat { hello }'))

        for (let run = 0; run < 2; run++) {
          const assertion = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, expectedSchema.server.opName)
            assert.strictEqual(traces[0][0].meta['graphql.operation.name'], 'Repeat')
          }, { spanResourceMatch: /Repeat/ })

          await Promise.all([
            assertion,
            (async () => query({}, {}, {}))(),
          ])
        }
      })

      it('traces a promise-returning execution', async () => {
        const { query } = compileQuery(schema, graphql.parse('query Slow { slow }'))

        const assertion = agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: expectedSchema.server.opName,
            error: 0,
            meta: { 'graphql.operation.type': 'query', 'graphql.operation.name': 'Slow' },
          })
        }, { spanResourceMatch: /Slow/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
        assert.deepStrictEqual(result.data, { slow: 'later' })
      })

      it('tags the execute span when a resolver errors', async () => {
        const { query } = compileQuery(schema, graphql.parse('query Boom { boom }'))

        const assertion = agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: expectedSchema.server.opName,
            error: 1,
            meta: { 'graphql.operation.name': 'Boom' },
          })
        }, { spanResourceMatch: /Boom/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
        assert.strictEqual(result.errors.length, 1)
      })

      it('aborts before a JIT-compiled resolver runs', async () => {
        const startChannel = dc.channel('apm:graphql:execute:start')
        /** @param {{ abortController: AbortController }} message */
        const handler = ({ abortController }) => abortController.abort()
        const { query } = compileQuery(schema, graphql.parse('query Blocked { hello }'))

        startChannel.subscribe(handler)
        try {
          const assertion = agent.assertSomeTraces(traces => {
            const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
            const resolve = traces[0].find(span => span.name === 'graphql.resolve')
            assert.strictEqual(execute.error, 0)
            assert.strictEqual(resolve, undefined)
          }, { spanResourceMatch: /Blocked/ })

          await Promise.all([
            assertion,
            (async () => {
              assert.throws(() => query({}, {}, {}), { name: 'AbortError', message: 'Aborted' })
            })(),
          ])
        } finally {
          startChannel.unsubscribe(handler)
        }
      })

      it('traces resolvers when the plugin is enabled after compilation', async () => {
        agent.reload('graphql', { enabled: false })
        const { query } = compileQuery(schema, graphql.parse('query EnabledLater { hello }'))
        agent.reload('graphql', { enabled: true, variables: ['name'] })

        const assertion = agent.assertSomeTraces(traces => {
          const resolve = traces[0].find(span => span.name === 'graphql.resolve')
          assert.ok(resolve, 'expected a graphql.resolve span after enabling the plugin')
        }, { spanResourceMatch: /EnabledLater/ })

        await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
      })
    })
  })
})
