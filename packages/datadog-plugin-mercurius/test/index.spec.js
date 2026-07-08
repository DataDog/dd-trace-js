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
        }
      `

      const resolvers = {
        Query: {
          hello: (_, { name }) => `Hello, ${name || 'world'}!`,
          fail: () => { throw new Error('resolver boom') },
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
        // A pre-parsed document AST reaches fastifyGraphQl as a non-string
        // source, so the request boundary has no query text to key the source
        // cache by. The cold call is still refined by validate, but a later
        // call hits mercurius's JIT path (no execute, no validate), so the
        // request span has to recover the operation metadata from the document
        // object itself. Gated to 15+: only fastify 5 exposes the pre-parsed
        // document path through app.graphql().
        const resolvedMercurius = require(`../../../versions/mercurius@${version}`).version()
        if (!semver.satisfies(resolvedMercurius, '>=15')) {
          this.skip()
        }

        const query = 'query ParsedAstWarm { hello(name: "ast") }'
        const document = require('../../../versions/graphql').get().parse(query)

        // Two cold runs compile the JIT for this document (execute still fires),
        // so the assertion call below is served exclusively from the compiled
        // path and its trace is the only one the handler sees.
        await app.graphql(document)
        await app.graphql(document)

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          const execute = traces[0].find(span => span.name === 'graphql.execute')
          assert.ok(request, 'expected a graphql.request span on the pre-parsed JIT warm path')
          assert.strictEqual(execute, undefined, 'JIT warm path must not produce a graphql.execute span')
          assertObjectContains(request, {
            meta: {
              'graphql.operation.type': 'query',
              'graphql.operation.name': 'ParsedAstWarm',
            },
          })
          assert.match(request.resource, /ParsedAstWarm/)
        })

        return Promise.all([assertion, app.graphql(document)])
      })

      it('leaves a non-cacheable source to mercurius without a tracer crash', async () => {
        // Mercurius rejects a source that is neither query text nor a document
        // AST, but it does so at different points: null/undefined fail in
        // validate before the parsed document exists, while a number reaches
        // validate as a truthy non-document. Neither has a usable cache key, so
        // the request boundary and validate must skip caching rather than key a
        // WeakMap by a primitive (which throws). The tracer must surface
        // mercurius's own rejection, never a TypeError of its own.
        await assert.rejects(app.graphql(null), /Must provide document/)
        await assert.rejects(app.graphql(42), /not iterable/)
      })

      it('carries the operation signature on the JIT warm path', async () => {
        // jit:1 compiles the query after its first run; subsequent runs take the
        // JIT path, which bypasses graphql.execute. The request span is the only
        // top-level span that survives that path. The cold run caches the
        // operation signature/type by source, so the warm run recovers the same
        // resource and tags at the request boundary without re-parsing.
        const query = 'query WarmQuery { hello(name: "jit") }'

        // Run twice up front so the assertion below observes the compiled run.
        await axios.post(`http://localhost:${port}/graphql`, { query })

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          const execute = traces[0].find(span => span.name === 'graphql.execute')
          assert.ok(request, 'expected a graphql.request span even when JIT-compiled')
          assert.strictEqual(execute, undefined, 'JIT warm path must not produce a graphql.execute span')
          assertObjectContains(request, {
            error: 0,
            meta: {
              'graphql.operation.type': 'query',
              'graphql.operation.name': 'WarmQuery',
              'graphql.source': query,
            },
          })
          assert.match(request.resource, /WarmQuery/)
        }, { spanResourceMatch: /WarmQuery/ })

        return Promise.all([assertion, axios.post(`http://localhost:${port}/graphql`, { query })])
      })

      it('labels a JIT-only sibling operation from the shared document, not the last one cached', async () => {
        // Mercurius parses a multi-operation document once and keys its LRU by
        // source, but compiles the JIT for a single operationName; the compiled
        // query then serves that operation for every later request sharing the
        // source, and neither validate nor execute fires. Here `First` runs cold
        // and `Second` is only ever served through the JIT path, so its metadata
        // has to be cached from the single cold parse — not left to a `Second`
        // execute that never happens. Both operations are labeled with their own
        // signature and type, never the sibling's.
        const source = 'query First { hello(name: "first") } query Second { hello(name: "second") }'

        // Cold run selecting `First`: validate refines the span and caches every
        // named operation in the document, `Second` included.
        await axios.post(`http://localhost:${port}/graphql`, { query: source, operationName: 'First' })
        // First `Second` request compiles the JIT for Second (execute skipped).
        await axios.post(`http://localhost:${port}/graphql`, { query: source, operationName: 'Second' })

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          const execute = traces[0].find(span => span.name === 'graphql.execute')
          assert.ok(request, 'expected a graphql.request span on the JIT warm path')
          assert.strictEqual(execute, undefined, 'JIT warm path must not produce a graphql.execute span')
          assertObjectContains(request, {
            meta: {
              'graphql.operation.type': 'query',
              'graphql.operation.name': 'Second',
            },
          })
          assert.match(request.resource, /Second/)
          assert.doesNotMatch(request.resource, /First/)
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
