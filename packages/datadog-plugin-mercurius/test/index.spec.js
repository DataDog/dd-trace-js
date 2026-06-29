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
          // The request span's resource is backfilled from the execute span's
          // computed operation signature, so the two must match.
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

      it('tags the request span when validation fails before execute', () => {
        // An unknown field fails validation inside fastifyGraphQl, before
        // graphql.execute runs. The request span is rejected by the wrapped
        // promise, so the orchestrion error event tags it even though no
        // execute span (and no backfill) ever happens.
        const query = 'query BadQuery { nope }'

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          assert.ok(request, 'expected a graphql.request span')
          assert.strictEqual(request.error, 1)
        })

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

      it('still produces a graphql.request span on the JIT warm path', async () => {
        // jit:1 compiles the query after its first run; subsequent runs take the
        // JIT path, which bypasses graphql.execute. The request span is the only
        // top-level span that survives that path. It carries the source (set at
        // the boundary, before any execute), even though the operation
        // signature backfill — which lives in the execute sub-plugin — does not
        // run on the warm path.
        const query = 'query WarmQuery { hello(name: "jit") }'

        // Run twice up front so the assertion below observes the compiled run.
        await axios.post(`http://localhost:${port}/graphql`, { query })

        const assertion = agent.assertSomeTraces(traces => {
          const request = traces[0].find(span => span.name === expectedSchema.server.opName)
          assert.ok(request, 'expected a graphql.request span even when JIT-compiled')
          assert.strictEqual(request.meta['graphql.source'], query)
        })

        return Promise.all([assertion, axios.post(`http://localhost:${port}/graphql`, { query })])
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
