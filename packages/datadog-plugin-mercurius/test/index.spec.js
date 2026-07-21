'use strict'

const assert = require('node:assert/strict')

const axios = require('axios')
const { after, before, describe, it } = require('mocha')
const semver = require('semver')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')

// mercurius 15+ requires Node 20.9+ (it ships fastify 5, which enforces it).
// Skip those versions on older Node so the oldest-LTS CI leg exercises the 13/14
// line instead of crashing on an unsupported runtime.
function supportedOnThisNode (version) {
  if (semver.satisfies(version, '>=15')) {
    return semver.satisfies(process.versions.node, '>=20.9.0')
  }
  return true
}

describe('Plugin', () => {
  describe('mercurius', () => {
    withVersions('mercurius', 'mercurius', version => {
      let app
      let port

      const schema = `
        type Query {
          hello(name: String): String
          fail: String
          failWithExtensions: String
        }
      `

      const resolvers = {
        Query: {
          hello: (_, { name }) => `Hello, ${name || 'world'}!`,
          fail: () => { throw new Error('resolver boom') },
          failWithExtensions: () => {
            const mercurius = require(`../../../versions/mercurius@${version}`).get()
            throw new mercurius.ErrorWithProps('resolver boom', { code: 'BOOM', extra: 'ignored' })
          },
        },
      }

      before(function () {
        if (!supportedOnThisNode(require(`../../../versions/mercurius@${version}`).version())) {
          this.skip()
        }
      })

      before(async function () {
        this.timeout(20000)

        require('../../dd-trace')
        // `source: true` opts the request text into `graphql.source` (#1141);
        // it is off by default to keep the query out of spans unless asked.
        await agent.load(['graphql', 'fastify', 'http'], [{ source: true }, {}, { client: false }])

        // mercurius <=14 needs fastify 4 (fastify-plugin ^4); 15+ needs fastify 5.
        const resolvedMercurius = require(`../../../versions/mercurius@${version}`).version()
        const fastifyKey = semver.satisfies(resolvedMercurius, '>=15') ? '5' : '4'
        const Fastify = require(`../../../versions/fastify@${fastifyKey}`).get()
        const mercurius = require(`../../../versions/mercurius@${version}`).get()

        app = Fastify()
        app.register(mercurius, { schema, resolvers, jit: 1 })
        await app.ready()
        await app.listen({ port: 0 })
        port = app.server.address().port

        // Prime the JIT path so a later request runs the warm (compiled) query.
        await axios.post(`http://localhost:${port}/graphql`, { query: '{ hello(name: "warmup") }' })
      })

      after(async () => {
        await app?.close()
        await agent.close({ ritmReset: false })
      })

      withNamingSchema(
        () => axios.post(`http://localhost:${port}/graphql`, {
          query: 'query MyQuery { hello(name: "world") }',
        }),
        rawExpectedSchema.server,
        {
          selectSpan: traces => traces[0].find(span => span.name === expectedSchema.server.opName),
        }
      )

      it('opens a top-level graphql.request span carrying the source and operation', () => {
        const query = 'query MyQuery { hello(name: "world") }'

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          assert.ok(request, 'expected a graphql.request span')
          assertObjectContains(request, {
            service: expectedSchema.server.serviceName,
            name: expectedSchema.server.opName,
            type: 'graphql',
            error: 0,
            meta: {
              'graphql.operation.type': 'query',
              'graphql.operation.name': 'MyQuery',
              'graphql.source': query,
              component: 'graphql',
            },
          })
        }, { spanResourceMatch: /MyQuery/ })

        return Promise.all([assertion, axios.post(`http://localhost:${port}/graphql`, { query })])
      })

      it('skips only the exact Apollo health-check on cold and JIT paths', async () => {
        const healthCheck = 'query __ApolloServiceHealthCheck__ { __typename }'
        const sentinel = 'query __ApolloServiceHealthCheck__ { hello }'
        const graphqlSpans = new Map()
        /**
         * @param {Array<Array<{ name: string }>>} traces
         */
        const collect = traces => {
          for (const trace of traces) {
            for (const span of trace) {
              if (span.name.startsWith('graphql.')) {
                graphqlSpans.set(span.name, (graphqlSpans.get(span.name) ?? 0) + 1)
              }
            }
          }
        }
        agent.subscribe(collect)

        try {
          const assertion = agent.assertSomeTraces(() => {
            assert.strictEqual(graphqlSpans.get(expectedSchema.server.opName), 1,
              'only the sentinel may emit a graphql.request span')
            assert.strictEqual(graphqlSpans.get('graphql.parse'), 1,
              'only the sentinel may emit a graphql.parse span')
            assert.strictEqual(graphqlSpans.get('graphql.validate'), 1,
              'only the sentinel may emit a graphql.validate span')
            assert.strictEqual(graphqlSpans.get('graphql.execute'), 1,
              'only the sentinel may emit a graphql.execute span')
            assert.strictEqual(graphqlSpans.get('graphql.resolve'), 1,
              'only the sentinel may emit a graphql.resolve span')
          }, { spanResourceMatch: /__ApolloServiceHealthCheck__/ })

          await Promise.all([
            assertion,
            (async () => {
              await axios.post(`http://localhost:${port}/graphql`, { query: healthCheck })
              await axios.post(`http://localhost:${port}/graphql`, { query: healthCheck })
              await axios.post(`http://localhost:${port}/graphql`, { query: sentinel })
            })(),
          ])
        } finally {
          agent.unsubscribe(collect)
        }
      })

      it('parents graphql.execute under graphql.request and shares its resource', () => {
        const query = 'query Nested { hello(name: "nested") }'

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          const execute = traces[0].find(span => span.name === 'graphql.execute')
          assert.ok(request, 'expected a graphql.request span')
          assert.ok(execute, 'expected a graphql.execute span')
          assert.strictEqual(execute.parent_id.toString(), request.span_id.toString())
          // Both spans derive the resource from the same operation signature
          // (the request span in validate, the execute span in execute), so the
          // two must match.
          assert.strictEqual(request.resource, execute.resource)
        }, { spanResourceMatch: /Nested/ })

        return Promise.all([assertion, axios.post(`http://localhost:${port}/graphql`, { query })])
      })

      it('tags the request span when a resolver throws', () => {
        const query = 'query FailQuery { fail }'

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          assert.ok(request, 'expected a graphql.request span')
          assert.strictEqual(request.error, 1)
        }, { spanResourceMatch: /FailQuery/ })

        return Promise.all([assertion, axios.post(`http://localhost:${port}/graphql`, { query })])
      })

      it('tags and labels the request span when validation fails before execute', () => {
        // An unknown field fails validation inside fastifyGraphQl, before
        // graphql.execute runs. validate still sees the parsed document, so the
        // request span is refined with the operation signature/type/name there —
        // even for a named query sent without a separate operationName argument,
        // and even though no execute span ever fires. Without that the error span
        // finishes with a bare resource and no operation tags, which makes these
        // traces hard to group.
        const query = 'query BadQuery { nope }'

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          const execute = traces[0].find(span => span.name === 'graphql.execute')
          assert.ok(request, 'expected a graphql.request span')
          assert.strictEqual(execute, undefined, 'validation failure must not produce a graphql.execute span')
          assertObjectContains(request, {
            error: 1,
            meta: {
              'graphql.operation.type': 'query',
              'graphql.operation.name': 'BadQuery',
            },
          })
          assert.match(request.resource, /BadQuery/)
        }, { spanResourceMatch: /BadQuery/ })

        return Promise.all([
          assertion,
          axios.post(`http://localhost:${port}/graphql`, { query }).catch(() => {}),
        ])
      })

      it('opens a request span for an anonymous operation', () => {
        const query = '{ hello(name: "anon") }'

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span =>
            span.name === expectedSchema.server.opName && span.meta['graphql.source'] === query)
          assert.ok(request, 'expected a graphql.request span for the anonymous query')
          assert.strictEqual(request.error, 0)
        })

        return Promise.all([assertion, axios.post(`http://localhost:${port}/graphql`, { query })])
      })

      it('opens a request span for a programmatic app.graphql() call', () => {
        const query = 'query Programmatic { hello(name: "prog") }'

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          assert.ok(request, 'expected a graphql.request span for app.graphql()')
          assert.strictEqual(request.meta['graphql.operation.name'], 'Programmatic')
        }, { spanResourceMatch: /Programmatic/ })

        return Promise.all([assertion, app.graphql(query)])
      })

      it('opens a request span for a pre-parsed document without a source tag', () => {
        const resolvedMercurius = require(`../../../versions/mercurius@${version}`).version()
        if (!semver.satisfies(resolvedMercurius, '>=15')) {
          return
        }

        const query = 'query ParsedAst { hello(name: "ast") }'
        const document = require('../../../versions/graphql').get().parse(query)

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          assert.ok(request, 'expected a graphql.request span for a parsed AST')
          assert.strictEqual(request.meta['graphql.operation.name'], 'ParsedAst')
          assert.ok(!('graphql.source' in request.meta), 'graphql.source must be absent for a parsed AST')
        }, { spanResourceMatch: /ParsedAst/ })

        return Promise.all([assertion, app.graphql(document)])
      })

      it('carries the operation signature for a pre-parsed document on the JIT warm path', async function () {
        // Only fastify 5 exposes pre-parsed documents through app.graphql().
        const resolvedMercurius = require(`../../../versions/mercurius@${version}`).version()
        if (!semver.satisfies(resolvedMercurius, '>=15')) {
          this.skip()
        }

        const query = 'query ParsedAstWarm { hello(name: "ast") }'
        const document = require('../../../versions/graphql').get().parse(query)

        await app.graphql(document)
        await app.graphql(document)

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          const execute = traces[0].find(span => span.name === 'graphql.execute')
          assert.ok(request, 'expected a graphql.request span on the pre-parsed JIT warm path')
          assert.ok(execute, 'expected a graphql.execute span on the pre-parsed JIT warm path')
          assert.strictEqual(execute.parent_id.toString(), request.span_id.toString())
          assertObjectContains(request, {
            meta: {
              'graphql.operation.type': 'query',
              'graphql.operation.name': 'ParsedAstWarm',
            },
          })
          assert.match(request.resource, /ParsedAstWarm/)
          assert.strictEqual(execute.resource, request.resource)
        })

        return Promise.all([assertion, app.graphql(document)])
      })

      it('preserves mercurius errors for invalid source values', async () => {
        await assert.rejects(app.graphql(null), /Must provide document/)
        await assert.rejects(app.graphql(42), /not iterable/)
      })

      it('carries the operation signature on the JIT warm path', async () => {
        const query = 'query WarmQuery { hello(name: "jit") }'

        await axios.post(`http://localhost:${port}/graphql`, { query })

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          const execute = traces[0].find(span => span.name === 'graphql.execute')
          const resolve = traces[0].find(span => span.name === 'graphql.resolve')
          assert.ok(request, 'expected a graphql.request span even when JIT-compiled')
          assert.ok(execute, 'expected a graphql.execute span even when JIT-compiled')
          assert.ok(resolve, 'expected a graphql.resolve span even when JIT-compiled')
          assert.strictEqual(execute.parent_id.toString(), request.span_id.toString())
          assert.strictEqual(resolve.parent_id.toString(), execute.span_id.toString())
          assert.strictEqual(resolve.meta['graphql.field.coordinates'], 'Query.hello')
          assertObjectContains(request, {
            error: 0,
            meta: {
              'graphql.operation.type': 'query',
              'graphql.operation.name': 'WarmQuery',
              'graphql.source': query,
            },
          })
          assert.match(request.resource, /WarmQuery/)
          assert.strictEqual(execute.resource, request.resource)
        }, { spanResourceMatch: /WarmQuery/ })

        return Promise.all([assertion, axios.post(`http://localhost:${port}/graphql`, { query })])
      })

      it('labels the selected operation on the JIT warm path', async () => {
        const source = 'query First { hello(name: "first") } query Second { hello(name: "second") }'

        await axios.post(`http://localhost:${port}/graphql`, { query: source, operationName: 'First' })
        await axios.post(`http://localhost:${port}/graphql`, { query: source, operationName: 'Second' })

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          const execute = traces[0].find(span => span.name === 'graphql.execute')
          assert.ok(request, 'expected a graphql.request span on the JIT warm path')
          assert.ok(execute, 'expected a graphql.execute span on the JIT warm path')
          assert.strictEqual(execute.parent_id.toString(), request.span_id.toString())
          assertObjectContains(request, {
            meta: {
              'graphql.operation.type': 'query',
              'graphql.operation.name': 'Second',
            },
          })
          assert.match(request.resource, /Second/)
          assert.doesNotMatch(request.resource, /First/)
          assert.strictEqual(execute.resource, request.resource)
        }, { spanResourceMatch: /Second/ })

        return Promise.all([
          assertion,
          axios.post(`http://localhost:${port}/graphql`, { query: source, operationName: 'Second' }),
        ])
      })

      describe('with the default source config', () => {
        let plainApp
        let plainPort

        before(async function () {
          this.timeout(20000)

          require('../../dd-trace')
          await agent.load(['graphql', 'fastify', 'http'], [{}, {}, { client: false }])

          const resolvedMercurius = require(`../../../versions/mercurius@${version}`).version()
          const fastifyKey = semver.satisfies(resolvedMercurius, '>=15') ? '5' : '4'
          const Fastify = require(`../../../versions/fastify@${fastifyKey}`).get()
          const mercurius = require(`../../../versions/mercurius@${version}`).get()

          plainApp = Fastify()
          plainApp.register(mercurius, { schema, resolvers })
          await plainApp.ready()
          await plainApp.listen({ port: 0 })
          plainPort = plainApp.server.address().port
        })

        after(async () => {
          await plainApp?.close()
          await agent.close({ ritmReset: false })
        })

        it('omits graphql.source unless source is enabled', () => {
          const query = 'query NoSource { hello(name: "world") }'

          const assertion = agent.assertSomeTraces(traces => {
            const request = traces[0].find(span => span.name === expectedSchema.server.opName)
            assert.ok(request, 'expected a graphql.request span')
            assert.ok(!('graphql.source' in request.meta), 'graphql.source must be absent by default')
          }, { spanResourceMatch: /NoSource/ })

          return Promise.all([assertion, axios.post(`http://localhost:${plainPort}/graphql`, { query })])
        })
      })

      describe('with configured error extensions', () => {
        let extApp
        let extPort

        before(async function () {
          this.timeout(20000)

          require('../../dd-trace')
          await agent.load(['graphql', 'fastify', 'http'], [{ errorExtensions: ['code'] }, {}, { client: false }])

          const resolvedMercurius = require(`../../../versions/mercurius@${version}`).version()
          const fastifyKey = semver.satisfies(resolvedMercurius, '>=15') ? '5' : '4'
          const Fastify = require(`../../../versions/fastify@${fastifyKey}`).get()
          const mercurius = require(`../../../versions/mercurius@${version}`).get()

          extApp = Fastify()
          extApp.register(mercurius, { schema, resolvers })
          await extApp.ready()
          await extApp.listen({ port: 0 })
          extPort = extApp.server.address().port
        })

        after(async () => {
          await extApp?.close()
          await agent.close({ ritmReset: false })
        })

        it('copies the configured error extension onto the request span error event', () => {
          // The graphql.request span is the only top-level span mercurius always
          // produces, so its error event has to honor the graphql plugin's
          // `errorExtensions` config the same way the execute/validate spans do —
          // it reads the plugin config, not the global tracer config.
          const query = 'query ExtQuery { failWithExtensions }'

          const assertion = agent.assertSomeTraces(traces => {
            const request = traces[0].find(span => span.name === expectedSchema.server.opName)
            assert.ok(request, 'expected a graphql.request span')
            assert.strictEqual(request.error, 1)

            const spanEvents = agent.unformatSpanEvents(request)
            assert.strictEqual(spanEvents.length, 1)
            assert.strictEqual(spanEvents[0].name, 'dd.graphql.query.error')
            assert.strictEqual(spanEvents[0].attributes['extensions.code'], 'BOOM')
            assert.ok(
              !Object.hasOwn(spanEvents[0].attributes, 'extensions.extra'),
              'only configured extensions are copied'
            )
          }, { spanResourceMatch: /ExtQuery/ })

          return Promise.all([assertion, axios.post(`http://localhost:${extPort}/graphql`, { query })])
        })
      })

      describe('with batched queries', () => {
        let batchApp
        let batchPort

        before(async function () {
          this.timeout(20000)

          require('../../dd-trace')
          await agent.load(['graphql', 'fastify', 'http'], [{ source: true }, {}, { client: false }])

          const resolvedMercurius = require(`../../../versions/mercurius@${version}`).version()
          const fastifyKey = semver.satisfies(resolvedMercurius, '>=15') ? '5' : '4'
          const Fastify = require(`../../../versions/fastify@${fastifyKey}`).get()
          const mercurius = require(`../../../versions/mercurius@${version}`).get()

          batchApp = Fastify()
          batchApp.register(mercurius, { schema, resolvers, allowBatchedQueries: true })
          await batchApp.ready()
          await batchApp.listen({ port: 0 })
          batchPort = batchApp.server.address().port
        })

        after(async () => {
          await batchApp?.close()
          await agent.close({ ritmReset: false })
        })

        it('opens one graphql.request span per operation in the batch', () => {
          // mercurius runs each batch element through `fastifyGraphQl`
          // independently, so the funnel must yield one request span per
          // operation — not one per HTTP request. Each operation's source ends
          // up on its own span.
          const batch = [
            { query: 'query BatchA { hello(name: "a") }' },
            { query: 'query BatchB { hello(name: "b") }' },
          ]

          const sawA = agent.assertSomeTraces(traces => {
            const request = traces[0].find(span =>
              span.name === expectedSchema.server.opName && /BatchA/.test(span.meta['graphql.source']))
            assert.ok(request, 'expected a graphql.request span for BatchA')
            assert.strictEqual(request.meta['graphql.operation.name'], 'BatchA')
          })

          const sawB = agent.assertSomeTraces(traces => {
            const request = traces[0].find(span =>
              span.name === expectedSchema.server.opName && /BatchB/.test(span.meta['graphql.source']))
            assert.ok(request, 'expected a graphql.request span for BatchB')
            assert.strictEqual(request.meta['graphql.operation.name'], 'BatchB')
          })

          return Promise.all([sawA, sawB, axios.post(`http://localhost:${batchPort}/graphql`, batch)])
        })
      })
    })
  })
})
