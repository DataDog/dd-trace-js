'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createRequire } = require('node:module')
const { promisify } = require('node:util')

const { afterEach, beforeEach, describe, it } = require('mocha')

const createConfig = require('../../dd-trace/src/config')
const agent = require('../../dd-trace/test/plugins/agent')
const externals = require('../../dd-trace/test/plugins/externals')
const { resolvePluginVersions } = require('../../dd-trace/test/plugins/versions')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

/** @param {import('node:http').Server} server */
async function closeLoopbackServer (server) {
  const close = promisify(server.close.bind(server))
  const closed = close()
  server.closeIdleConnections?.()
  await closed
}

/**
 * @param {{
 *   listen: (options: { host: string, port: number }, callback: (error: Error | null) => void) => void,
 *   server: import('node:http').Server
 * }} app
 */
async function listenOnLoopback (app) {
  const listen = promisify(app.listen.bind(app))
  await listen({ host: '127.0.0.1', port: 0 })
  const { port } = /** @type {import('node:net').AddressInfo} */ (app.server.address())
  return 'http://127.0.0.1:' + port
}

/**
 * @param {string} address
 * @param {number} priority
 * @param {string} [path]
 */
async function assertPropagatedPriority (address, priority, path = '/items/42') {
  const { data } = await httpRequest.get(address + path)
  assert.deepStrictEqual(data, { priority: String(priority) })
}

/**
 * @param {typeof import('../../dd-trace')} tracer
 * @param {import('node:http').ServerResponse} res
 */
function respondWithPriority (tracer, res) {
  const carrier = {}
  tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ priority: carrier['x-datadog-sampling-priority'] }))
}

describe('Fastify resource sampling', () => {
  withVersions('fastify', 'fastify', version => {
    let app
    let tracer

    beforeEach(async () => {
      await agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false }], {
        sampleRate: 0,
        rateLimit: -1,
        samplingRules: [{ resource: 'GET /items/:id', sampleRate: 1 }],
      })
      tracer = require('../../dd-trace')
      const fastify = require('../../../versions/fastify@' + version).get()
      app = fastify()
    })

    afterEach(async () => {
      if (app) await app.close()
      await agent.close()
    })

    it('matches the native route before propagation in a request hook', async () => {
      const carrier = {}
      app.addHook('onRequest', (req, reply, done) => {
        tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
        done()
      })
      app.get('/items/:id', (req, reply) => reply.send({ priority: carrier['x-datadog-sampling-priority'] }))
      const address = await listenOnLoopback(app)

      await Promise.all([
        assertPropagatedPriority(address, 2),
        agent.assertFirstTraceSpan({ resource: 'GET /items/:id', metrics: { _sampling_priority_v1: 2 } }),
      ])
    })
  })

  for (const rewriteUrl of [undefined, () => '/items/42']) {
    withVersions('fastify', 'fastify', rewriteUrl ? '>=3' : '*', version => {
      const title = rewriteUrl
        ? 'dispatches a rewritten URL without an HTTP server span'
        : 'dispatches without an HTTP server span'

      it(title, async () => {
        const tracer = await agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false, server: false }])
        const fastify = require('../../../versions/fastify@' + version).get()
        const app = fastify(rewriteUrl ? { rewriteUrl } : undefined)
        try {
          app.get('/items/:id', (request, reply) => {
            assert.strictEqual(tracer.scope().active(), null)
            return reply.send(request.params)
          })
          const address = await listenOnLoopback(app)
          const { status, data } = await httpRequest.get(address + (rewriteUrl ? '/before-rewrite' : '/items/42'))
          assert.strictEqual(status, 200)
          assert.deepStrictEqual(data, { id: '42' })
        } finally {
          await app.close()
          await agent.close()
        }
      })
    })
  }

  for (const { label, fastifyEnabled, routerEnabled } of [
    { label: 'both plugins', fastifyEnabled: true, routerEnabled: true },
    { label: 'find-my-way only', fastifyEnabled: false, routerEnabled: true },
    { label: 'Fastify only', fastifyEnabled: true, routerEnabled: false },
  ]) {
    withVersions('fastify', 'fastify', '>=3', version => {
      it(`defers route sampling in rewriteUrl when the router tracks selection (${label})`, async () => {
        const pluginConfig = [{ enabled: fastifyEnabled }, { enabled: routerEnabled }, { client: false }]
        await agent.load(['fastify', 'find-my-way', 'http'], pluginConfig, {
          sampleRate: 0,
          rateLimit: -1,
          samplingRules: [{ resource: 'GET', sampleRate: 1 }],
        })
        const tracer = require('../../dd-trace')
        const createFastify = require('../../../versions/fastify@' + version).get()
        const carrier = {}
        const fastify = createFastify({
          rewriteUrl () {
            if (tracer.scope().active()) {
              tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
            }
            return '/rewritten/42'
          },
        })
        fastify.get('/rewritten/:id', (req, reply) => reply.send({ priority: carrier['x-datadog-sampling-priority'] }))

        try {
          const address = await listenOnLoopback(fastify)
          const resource = routerEnabled ? 'GET /rewritten/:id' : 'GET'
          const keep = !routerEnabled && createConfig().DD_TRACE_OTEL_SEMANTICS_ENABLED
          await Promise.all([
            assertPropagatedPriority(address, keep ? 2 : -1),
            keep
              ? agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } })
              : agent.assertUserRejectedTrace(resource),
          ])
        } finally {
          await fastify.close()
          await agent.close()
        }
      })
    })
  }

  withVersions('fastify', 'fastify', '>=5', version => {
    it('drops a provisional Express route before Fastify rewrites the URL', async () => {
      const outer = 'GET /items/:outer'
      const inner = 'GET /items/:inner'
      const tracer = await agent.load(['http', 'express', 'router', 'fastify', 'find-my-way'],
        [{ client: false }, { middleware: false }, { middleware: false }, {}, {}], {
          sampleRate: 0,
          rateLimit: -1,
          samplingRules: [{ resource: outer, sampleRate: 1 }, { resource: inner, sampleRate: 1 }],
        })
      const express = require('../../../versions/express@5').get()
      const createFastify = require('../../../versions/fastify@' + version).get()
      const headers = {}
      const fastify = createFastify({
        rewriteUrl (req) {
          if (req.url.endsWith('?rewrite')) {
            tracer.trace('outbound', span => tracer.inject(span, 'http_headers', headers))
          }
          return '/items/42'
        },
      })
      fastify.get('/items/:inner', (req, reply) => respondWithPriority(tracer, reply.raw))
      const app = express()
      app.param('outer', (req, res) => fastify.routing(req, res))
      app.get('/items/:outer', (_req, res) => res.sendStatus(500))
      await fastify.ready()
      const server = app.listen(0, '127.0.0.1')

      try {
        await once(server, 'listening')
        const address = 'http://127.0.0.1:' + server.address().port
        await Promise.all([
          assertPropagatedPriority(address, 2),
          agent.assertFirstTraceSpan({ resource: inner, metrics: { _sampling_priority_v1: 2 } }),
        ])
        await Promise.all([
          assertPropagatedPriority(address, -1, '/items/42?rewrite'),
          agent.assertUserRejectedTrace(inner),
        ])
        assert.strictEqual(headers['x-datadog-sampling-priority'], '-1')
      } finally {
        await new Promise(resolve => server.close(resolve))
        await fastify.close()
        await agent.close()
      }
    })
  })

  for (const { range, mode, compile } of [
    { range: '>=1.14.6 <4', mode: 'version' },
    { range: '>=4', mode: 'sync' },
    { range: '>=4', mode: 'async' },
    { range: '>=5.12.8', mode: 'sync', compile: true },
    { range: '>=5.12.8', mode: 'async', compile: true },
  ]) {
    withVersions('fastify', 'fastify', range, version => {
      const stage = compile ? mode + ', compiled' : mode
      it(`ignores bare HTTP while deriving route constraints (${stage})`, async function () {
        const tracer = await agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false }], {
          sampleRate: 0,
          rateLimit: -1,
          samplingRules: [{ resource: 'GET', sampleRate: 1 }],
        })
        const fixture = require('../../../versions/fastify@' + version)
        const createFastify = fixture.get()
        const carrier = {}
        const deriveTenant = request => {
          tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
          return request.headers['x-tenant']
        }
        const app = createFastify(mode === 'version'
          ? { versioning: { storage: () => new Map(), deriveVersion: deriveTenant } }
          : { routerOptions: { compile } })

        try {
          if (mode === 'async') {
            const fromFastify = createRequire(fixture.getPath('fastify'))
            const FindMyWay = fromFastify('find-my-way')
            if (FindMyWay().constrainer.asyncStrategiesInUse === undefined) return this.skip()
          }
          const tenant = '1.0.0'
          const routeOptions = mode === 'version' ? { version: tenant } : { constraints: { tenant } }
          if (mode !== 'version') {
            app.addConstraintStrategy({
              name: 'tenant',
              storage: () => new Map(),
              deriveConstraint: mode === 'async'
                ? (request, _context, done) => queueMicrotask(() => done(null, deriveTenant(request)))
                : deriveTenant,
            })
          }
          app.get('/items/:id', routeOptions, (req, reply) => {
            reply.send({ id: req.params.id, priority: carrier['x-datadog-sampling-priority'] })
          })

          const address = await listenOnLoopback(app)
          const [{ status, data }] = await Promise.all([
            httpRequest.get(address + '/items/42', { headers: { 'x-tenant': tenant } }),
            agent.assertUserRejectedTrace('GET /items/:id'),
          ])
          assert.strictEqual(status, 200)
          assert.deepStrictEqual(data, { id: '42', priority: '-1' })
        } finally {
          await app.close()
          await agent.close()
        }
      })
    })
  }

  const { unversioned: expressRange } = resolvePluginVersions({
    name: 'express',
    declarations: externals.fastify.filter(({ name }) => name === 'express'),
    honourEnvRange: false,
  })

  if (expressRange) {
    it('samples a standalone Express root with the method resource', async () => {
      const tracer = await agent.load(['http', 'express', 'router'], [{ client: false }], {
        sampleRate: 0,
        rateLimit: -1,
        samplingRules: [{ resource: 'GET', sampleRate: 1 }],
      })
      const createExpress = require('../../../versions/express@5').get()
      const app = createExpress()
      app.get('/', (req, res) => respondWithPriority(tracer, res))
      const server = app.listen(0, '127.0.0.1')

      try {
        await once(server, 'listening')
        await Promise.all([
          assertPropagatedPriority('http://127.0.0.1:' + server.address().port, 2, '/'),
          agent.assertFirstTraceSpan({ resource: 'GET', metrics: { _sampling_priority_v1: 2 } }),
        ])
      } finally {
        await closeLoopbackServer(server)
        await agent.close()
      }
    })
  }

  withVersions('fastify', 'fastify', '>=4.1', version => {
    it('samples the method in a terminal async constraint error handler', async () => {
      const tracer = await agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false }], {
        sampleRate: 0,
        rateLimit: -1,
        samplingRules: [{ resource: 'GET', sampleRate: 1 }],
      })
      const createFastify = require('../../../versions/fastify@' + version).get()
      const app = createFastify({
        constraints: {
          tenant: {
            name: 'tenant',
            storage: () => new Map(),
            validate () {},
            deriveConstraint (req, context, done) {
              process.nextTick(done, new Error('constraint error'))
            },
          },
        },
        frameworkErrors (error, request, reply) {
          const carrier = {}
          tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
          reply.code(500).send({ priority: carrier['x-datadog-sampling-priority'] })
        },
      })
      app.get('/items/:id', { constraints: { tenant: 'tenant' } }, () => assert.fail('unexpected normal route'))
      try {
        const address = await listenOnLoopback(app)
        const [{ data }] = await Promise.all([
          httpRequest.get(address + '/items/42', { validateStatus: code => code === 500 }),
          agent.assertFirstTraceSpan({ resource: 'GET', metrics: { _sampling_priority_v1: 2 } }),
        ])
        assert.deepStrictEqual(data, { priority: '2' })
      } finally {
        await app.close()
        await agent.close()
      }
    })
  })

  withVersions('fastify', 'fastify', '>=4', version => {
    for (const framework of ['standalone', 'Express']) {
      it(`samples the bare method in a default route (${framework})`, async () => {
        const plugins = ['find-my-way', 'http']
        const pluginOptions = [{}, { client: false }]
        if (framework === 'Express') {
          plugins.push('express', 'router')
          pluginOptions.push({ middleware: false }, { middleware: false })
        }
        const tracer = await agent.load(plugins, pluginOptions, {
          sampleRate: 0,
          rateLimit: -1,
          samplingRules: [{ resource: 'GET', sampleRate: 1 }],
        })
        const { createServer } = require('node:http')
        const fixture = require('../../../versions/fastify@' + version)
        const fromFastify = createRequire(fixture.getPath('fastify'))
        const FindMyWay = fromFastify('find-my-way')
        let defaultRoute = (req, res) => {
          res.statusCode = 404
          respondWithPriority(tracer, res)
        }
        if (framework === 'Express') {
          const express = require('../../../versions/express@5').get()
          const app = express()
          app.get('/', defaultRoute)
          defaultRoute = app
        }
        const router = FindMyWay({ defaultRoute })
        const server = createServer((req, res) => router.lookup(req, res)).listen(0, '127.0.0.1')

        try {
          await once(server, 'listening')
          const address = 'http://127.0.0.1:' + server.address().port
          const [response] = await Promise.all([
            fetch(address + '/'),
            agent.assertFirstTraceSpan({ resource: 'GET', metrics: { _sampling_priority_v1: 2 } }),
          ])
          assert.strictEqual(response.status, 404)
          assert.deepStrictEqual(await response.json(), { priority: '2' })
        } finally {
          await closeLoopbackServer(server)
          await agent.close()
        }
      })
    }

    for (const [handler, path] of [['onBadUrl', '/items/%'], ['onMaxParamLength', '/items/12345']]) {
      it('samples the method in the terminal ' + handler + ' handler', async function () {
        const tracer = await agent.load(['find-my-way', 'http'], [{}, { client: false }], {
          sampleRate: 0,
          rateLimit: -1,
          samplingRules: [{ resource: 'GET', sampleRate: 1 }],
        })
        const { createServer } = require('node:http')
        const fixture = require('../../../versions/fastify@' + version)
        const fromFastify = createRequire(fixture.getPath('fastify'))
        const FindMyWay = fromFastify('find-my-way')
        if (handler === 'onMaxParamLength' && typeof FindMyWay.prototype._onMaxParamLength !== 'function') {
          await agent.close()
          return this.skip()
        }
        const router = FindMyWay({
          maxParamLength: 4,
          [handler] (_path, req, res) {
            respondWithPriority(tracer, res)
          },
        })
        router.on('GET', '/items/:id', () => assert.fail('unexpected normal route'))
        const server = createServer((req, res) => router.lookup(req, res)).listen(0, '127.0.0.1')
        try {
          await once(server, 'listening')
          const address = 'http://127.0.0.1:' + server.address().port
          await Promise.all([
            assertPropagatedPriority(address, 2, path),
            agent.assertFirstTraceSpan({ resource: 'GET', metrics: { _sampling_priority_v1: 2 } }),
          ])
        } finally {
          await closeLoopbackServer(server)
          await agent.close()
        }
      })
    }

    it('preserves constrained lookups with HTTP tracing disabled', async () => {
      await agent.load('find-my-way')
      const { createServer } = require('node:http')
      const fixture = require('../../../versions/fastify@' + version)
      const fromFastify = createRequire(fixture.getPath('fastify'))
      const FindMyWay = fromFastify('find-my-way')
      const router = FindMyWay({
        constraints: {
          tenant: {
            name: 'tenant',
            storage: () => new Map(),
            validate () {},
            deriveConstraint (req, context, callback) {
              if (callback === undefined) return 'tenant'
              process.nextTick(callback, null, 'tenant')
            },
          },
        },
      })
      router.on('GET', '/items/:id', { constraints: { tenant: 'tenant' } }, (req, res, params) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: params.id }))
      })
      const server = createServer((req, res) => {
        router.lookup(req, res, error => { if (error) res.destroy(error) })
      }).listen(0, '127.0.0.1')

      try {
        await once(server, 'listening')
        const address = 'http://127.0.0.1:' + server.address().port
        const [{ data }] = await Promise.all([
          httpRequest.get(address + '/items/42'),
          agent.assertNoTraces(() => assert.fail('Unexpected trace with HTTP disabled')),
        ])
        assert.deepStrictEqual(data, { id: '42' })
      } finally {
        await closeLoopbackServer(server)
        await agent.close()
      }
    })

    for (const scenario of ['nested method miss', 'delegated default handler', 'reentrant default handler']) {
      it('keeps a standalone lookup pending during a ' + scenario, async function () {
        const tracer = await agent.load(['find-my-way', 'http'], [{}, { client: false }], {
          sampleRate: 0,
          rateLimit: -1,
          samplingRules: [{ resource: 'GET', sampleRate: 1 }],
        })
        const { createServer } = require('node:http')
        const fixture = require('../../../versions/fastify@' + version)
        const fromFastify = createRequire(fixture.getPath('fastify'))
        const FindMyWay = fromFastify('find-my-way')
        const nestedMiss = scenario === 'nested method miss'
        const reentrant = scenario === 'reentrant default handler'
        const noMatch = Symbol('no match')
        const router = FindMyWay({ defaultRoute: () => noMatch })

        try {
          if (nestedMiss && typeof router.compile !== 'function') return this.skip()

          let request
          let response
          const carrier = {}

          class ConstraintStore extends Map {
            get (value) {
              if (request && nestedMiss) {
                const method = request.method
                request.method = 'POST'
                try {
                  assert.strictEqual(router.lookup(request, response), noMatch)
                } finally {
                  request.method = method
                }
              }
              if (request) {
                tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
              }
              return super.get(value)
            }
          }

          router.addConstraintStrategy({
            name: 'tenant',
            deriveConstraint (req) {
              if (reentrant) {
                const inner = FindMyWay({
                  defaultRoute () {
                    tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
                  },
                })
                inner.lookup(req, response)
              }
              return 'tenant'
            },
            storage: () => new ConstraintStore(),
          })
          router.on('GET', '/items/:id', { constraints: { tenant: 'tenant' } }, (req, res) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ priority: carrier['x-datadog-sampling-priority'] }))
          })
          if (nestedMiss) router.compile()
          const entry = nestedMiss || reentrant
            ? router
            : FindMyWay({ defaultRoute: (req, res) => router.lookup(req, res) })

          const server = createServer((req, res) => {
            request = req
            response = res
            entry.lookup(req, res)
          }).listen(0, '127.0.0.1')

          try {
            await once(server, 'listening')
            const address = 'http://127.0.0.1:' + server.address().port
            await Promise.all([
              assertPropagatedPriority(address, -1),
              agent.assertUserRejectedTrace('GET /items/:id'),
            ])
          } finally {
            await closeLoopbackServer(server)
          }
        } finally {
          await agent.close()
        }
      })
    }

    it('samples the bare method after the application clears the selected route tag', async () => {
      const tracer = await agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false }], {
        sampleRate: 0,
        rateLimit: -1,
        samplingRules: [{ resource: 'GET', sampleRate: 1 }],
      })
      const createFastify = require('../../../versions/fastify@' + version).get()
      const app = createFastify()
      app.get('/items/:id', (req, reply) => {
        tracer.scope().active().setTag('http.route', undefined)
        const carrier = {}
        tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
        reply.send({ priority: carrier['x-datadog-sampling-priority'] })
      })

      try {
        const address = await listenOnLoopback(app)
        await Promise.all([
          assertPropagatedPriority(address, 2),
          agent.assertFirstTraceSpan({ resource: 'GET', metrics: { _sampling_priority_v1: 2 } }),
        ])
      } finally {
        await app.close()
        await agent.close()
      }
    })

    for (const stage of [
      'misses', 'matches', 'derives a constraint', 'derives a compiled constraint', 'derives an async constraint',
      'derives a compiled async constraint',
      'misses after async derivation', 'throws in a constraint', 'reports an async constraint error',
      'checks a constraint store', 'checks a compiled constraint store', 'misses with compiled constraints',
      'checks a constraint store after a nested miss',
      'checks a compiled constraint store after a nested miss',
      'checks a compiled constraint store after a nested compiled miss',
      'checks a compiled constraint store after a same-router callback miss',
      'checks a compiled constraint store after a same-router method miss',
      'checks a query parser', 'checks a compiled query parser',
    ]) {
      it(`uses the current selection when a nested lookup ${stage}`, async function () {
        const tracer = await agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false }], {
          sampleRate: 0,
          rateLimit: -1,
          samplingRules: [{ resource: /^GET \/\*$/, sampleRate: 1 }],
        })
        const fixture = require('../../../versions/fastify@' + version)
        const createFastify = fixture.get()
        const fromFastify = createRequire(fixture.getPath('fastify'))
        const FindMyWay = fromFastify('find-my-way')
        const outer = createFastify()
        const carrier = {}
        const parsesQuery = stage.endsWith('query parser')
        const inner = FindMyWay({
          defaultRoute: (req, res) => sameRouterMiss ? noMatch : respond(req, res),
          querystringParser: parsesQuery
            ? query => {
              assert.strictEqual(query, 'mode=full')
              propagate()
              return { mode: 'full' }
            }
            : undefined,
        })
        const compiling = stage.includes('compiled')
        const asynchronous = stage.includes('async')
        const misses = stage.startsWith('misses')
        const throws = stage.includes('throws')
        const reportsError = stage.includes('error')
        const propagatesDuringDerivation = stage.startsWith('derives')
        const propagatesDuringMatch = stage.startsWith('checks')
        const nestedMiss = stage.includes('after a nested')
        const expectedError = new Error('invalid constraint')
        const noMatch = Symbol('no match')
        const nested = FindMyWay({ defaultRoute: () => noMatch })
        let rawRequest
        let rawResponse
        let sameRouterMiss = false

        function respond (req, res) {
          if (propagatesDuringDerivation || propagatesDuringMatch) {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ priority: carrier['x-datadog-sampling-priority'] }))
          } else {
            respondWithPriority(tracer, res)
          }
        }

        function propagate () {
          tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
        }

        function deriveConstraint () {
          if (throws) throw expectedError
          if (propagatesDuringDerivation) propagate()
          return misses ? 'other' : 'tenant'
        }

        class ConstraintStore extends Map {
          get (value) {
            if (propagatesDuringMatch && tracer.scope().active() && !sameRouterMiss) {
              if (nestedMiss) assert.strictEqual(nested.lookup(rawRequest, rawResponse), noMatch)
              if (stage.endsWith('same-router callback miss')) {
                const url = rawRequest.url
                let completed = false
                rawRequest.url = '/other'
                sameRouterMiss = true
                try {
                  inner.lookup(rawRequest, rawResponse, (error, result) => {
                    assert.strictEqual(error, null)
                    assert.strictEqual(result, noMatch)
                    propagate()
                    completed = true
                  })
                  assert.strictEqual(completed, true)
                } finally {
                  sameRouterMiss = false
                  rawRequest.url = url
                }
              } else if (stage.endsWith('same-router method miss')) {
                const method = rawRequest.method
                rawRequest.method = 'POST'
                sameRouterMiss = true
                try {
                  assert.strictEqual(inner.lookup(rawRequest, rawResponse), noMatch)
                } finally {
                  sameRouterMiss = false
                  rawRequest.method = method
                }
                propagate()
              } else {
                propagate()
              }
            }
            return super.get(value)
          }
        }

        try {
          if (compiling && typeof inner.compile !== 'function') return this.skip()
          if (asynchronous && inner.constrainer.asyncStrategiesInUse === undefined) return this.skip()
          if (stage !== 'matches' && stage !== 'misses' && !parsesQuery) {
            inner.addConstraintStrategy({
              name: 'tenant',
              storage: () => new ConstraintStore(),
              deriveConstraint: asynchronous
                ? (req, context, done) => queueMicrotask(() => {
                    if (reportsError) done(expectedError)
                    else done(null, deriveConstraint())
                  })
                : deriveConstraint,
            })
            inner.on('GET', '/items/:id', { constraints: { tenant: 'tenant' } }, respond)
          } else if (!misses) {
            inner.on('GET', '/items/:id', respond)
          }
          if (stage.endsWith('nested compiled miss')) {
            nested.on('GET', '/other', () => {})
            nested.compile()
          }
          if (compiling) inner.compile()

          outer.get('/*', (req, reply) => {
            reply.hijack()
            rawRequest = req.raw
            rawResponse = reply.raw
            if (asynchronous) {
              inner.lookup(req.raw, reply.raw, error => {
                if (reportsError) {
                  assert.strictEqual(error, expectedError)
                  respond(req.raw, reply.raw)
                } else {
                  assert.strictEqual(error, null)
                }
              })
            } else if (throws) {
              assert.throws(() => inner.lookup(req.raw, reply.raw), error => error === expectedError)
              respond(req.raw, reply.raw)
            } else {
              inner.lookup(req.raw, reply.raw)
            }
          })

          const usesOuter = misses || throws || reportsError
          const address = await listenOnLoopback(outer)
          const requests = stage === 'misses with compiled constraints' ? 2 : 1
          const path = parsesQuery ? '/items/42?mode=full' : undefined
          for (let request = 0; request < requests; request++) {
            await Promise.all([
              assertPropagatedPriority(address, usesOuter ? 2 : -1, path),
              usesOuter
                ? agent.assertFirstTraceSpan({ resource: 'GET /*', metrics: { _sampling_priority_v1: 2 } })
                : agent.assertUserRejectedTrace('GET /items/:id'),
            ])
          }
        } finally {
          await outer.close()
          await agent.close()
        }
      })
    }

    for (const stage of ['rewriteUrl', 'deriveConstraint']) {
      it('does not sample the outer route in the second router ' + stage, async () => {
        const tracer = await agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false }], {
          sampleRate: 0,
          rateLimit: -1,
          samplingRules: [{ resource: /^GET \/\*$/, sampleRate: 1 }],
        })
        const createFastify = require('../../../versions/fastify@' + version).get()
        const outer = createFastify()
        const carrier = {}
        function propagate () {
          tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
        }
        function rewriteUrl (req) {
          propagate()
          return req.url
        }
        const inner = createFastify(stage === 'rewriteUrl' ? { rewriteUrl } : {})
        const routeOptions = {}
        if (stage === 'deriveConstraint') {
          inner.addConstraintStrategy({
            name: 'tenant',
            storage: () => new Map(),
            deriveConstraint () {
              propagate()
              return 'tenant'
            },
          })
          routeOptions.constraints = { tenant: 'tenant' }
        }
        inner.get('/items/:id', routeOptions, (req, reply) => {
          reply.send({ priority: carrier['x-datadog-sampling-priority'] })
        })
        outer.get('/*', (req, reply) => {
          reply.hijack()
          inner.routing(req.raw, reply.raw)
        })

        try {
          await inner.ready()
          const address = await listenOnLoopback(outer)
          await Promise.all([
            assertPropagatedPriority(address, -1),
            agent.assertUserRejectedTrace('GET /items/:id'),
          ])
        } finally {
          await outer.close()
          await inner.close()
          await agent.close()
        }
      })
    }

    if (!expressRange) return

    for (const phase of ['constraint', 'handler']) {
      it(`uses the native route scope when Express delegates to FindMyWay at ${phase}`, async () => {
        const duringLookup = phase === 'constraint'
        const innerResource = 'GET /items/:inner'
        const tracer = await agent.load(['find-my-way', 'http', 'express', 'router'], [{}, { client: false }], {
          sampleRate: 0,
          rateLimit: -1,
          samplingRules: [{ resource: duringLookup ? 'GET /items/:outer' : innerResource, sampleRate: 1 }],
        })
        const fixture = require('../../../versions/fastify@' + version)
        const fromFastify = createRequire(fixture.getPath('fastify'))
        const FindMyWay = fromFastify('find-my-way')
        const createExpress = require('../../../versions/express@5').get()
        const express = createExpress()
        const router = FindMyWay()
        const carrier = {}
        router.addConstraintStrategy({
          name: 'tenant',
          storage: () => new Map(),
          deriveConstraint () {
            if (duringLookup) {
              tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
            }
            return 'tenant'
          },
        })
        router.on('GET', '/items/:inner', { constraints: { tenant: 'tenant' } }, (req, res, params) => {
          assert.strictEqual(params.inner, '42')
          if (duringLookup) {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ priority: carrier['x-datadog-sampling-priority'] }))
          } else {
            respondWithPriority(tracer, res)
          }
        })
        express.param('outer', (req, res) => router.lookup(req, res))
        express.get('/items/:outer', (req, res) => res.sendStatus(500))

        const server = express.listen(0, '127.0.0.1')
        const closeServer = promisify(server.close.bind(server))
        try {
          await once(server, 'listening')
          const address = 'http://127.0.0.1:' + server.address().port
          await Promise.all([
            assertPropagatedPriority(address, duringLookup ? -1 : 2),
            duringLookup
              ? agent.assertUserRejectedTrace(innerResource)
              : agent.assertFirstTraceSpan({ resource: innerResource, metrics: { _sampling_priority_v1: 2 } }),
          ])
        } finally {
          await closeServer()
          await agent.close()
        }
      })
    }

    /**
     * @param {string | RegExp} resource
     * @param {number} priority
     * @param {'items' | 'root' | 'rootArray' | 'rootWithoutTag' | 'fallthrough' |
     *   'middlewareArray' | 'middlewareFallthrough' | 'nestedMiddlewareFallthrough' | 'terminalUse'} [match]
     * @param {'4.0.0' | '4' | '5'} [expressVersion]
     */
    async function assertDelegatedSampling (resource, priority, match = 'items', expressVersion = '5') {
      await agent.load(['fastify', 'find-my-way', 'http', 'express', 'router'], [{}, {}, { client: false }], {
        sampleRate: 0,
        rateLimit: -1,
        samplingRules: [{ resource, sampleRate: 1 }],
      })
      const tracer = require('../../dd-trace')
      const createExpress = require(`../../../versions/express@${expressVersion}`).get()
      const createFastify = require('../../../versions/fastify@' + version).get()
      const express = createExpress()
      const fastify = createFastify()

      const nestedMiddleware = match === 'nestedMiddlewareFallthrough'
      const middlewareFallthrough = match === 'middlewareFallthrough' || nestedMiddleware
      const middlewarePath = match === 'middlewareArray' ? ['/items', '/'] : middlewareFallthrough ? '/items' : '/'
      const passThrough = (req, res, next) => next()
      if (nestedMiddleware) {
        const nested = createExpress.Router()
        nested.use('/:id', passThrough)
        express.use(middlewarePath, nested)
      } else {
        express.use(middlewarePath, passThrough)
      }
      const clearRoute = match === 'rootWithoutTag'
      const root = match === 'root' || match === 'rootArray' || clearRoute
      const fallsThrough = match === 'fallthrough' || match === 'middlewareArray' || middlewareFallthrough
      const terminalUse = match === 'terminalUse'
      const path = root ? '/' : terminalUse ? '/health' : '/items/:id'
      let requestSpan
      if (!fallsThrough) {
        express[terminalUse ? 'use' : 'get'](match === 'rootArray' ? [path, '/health'] : path, (req, res) => {
          if (clearRoute) requestSpan.setTag('http.route', undefined)
          respondWithPriority(tracer, res)
        })
      }
      fastify.get('/*', (req, reply) => {
        if (clearRoute) requestSpan = tracer.scope().active()
        reply.hijack()
        express(req.raw, reply.raw, () => respondWithPriority(tracer, reply.raw))
      })

      try {
        let expectedResource = 'GET ' + path
        if (fallsThrough) expectedResource = 'GET /*'
        if (clearRoute || (root && !createConfig().DD_TRACE_OTEL_SEMANTICS_ENABLED)) expectedResource = 'GET'
        const address = await fastify.listen({ host: '127.0.0.1', port: 0 })
        await Promise.all([
          assertPropagatedPriority(address, priority, root || terminalUse ? path : '/items/42'),
          priority === 2
            ? agent.assertFirstTraceSpan({ resource: expectedResource, metrics: { _sampling_priority_v1: 2 } })
            : agent.assertUserRejectedTrace(expectedResource),
        ])
      } finally {
        await fastify.close()
        await agent.close()
      }
    }

    it('samples the selected Express route after delegation', async () => {
      await assertDelegatedSampling('GET /items/:id', 2)
    })

    it('does not match a rule for the superseded outer route', async () => {
      await assertDelegatedSampling(/^GET \/\*$/, -1)
    })

    it('keeps the outer route when Express falls through without matching a route', async () => {
      await assertDelegatedSampling(/^GET \/\*$/, 2, 'fallthrough')
    })

    it('restores the outer route after Express middleware calls next', async () => {
      await assertDelegatedSampling(/^GET \/\*$/, 2, 'middlewareFallthrough')
    })

    it('restores the outer route after mounted Express middleware falls through', async () => {
      await assertDelegatedSampling(/^GET \/\*$/, 2, 'nestedMiddlewareFallthrough')
    })

    it('keeps the outer route when Express array middleware falls through', async () => {
      await assertDelegatedSampling(/^GET \/\*$/, 2, 'middlewareArray')
    })

    it('replaces the outer route when Express matches the root', async () => {
      await assertDelegatedSampling(/^GET \/\*$/, -1, 'root')
    })

    it('samples the selected Express root after delegation', async () => {
      const resource = createConfig().DD_TRACE_OTEL_SEMANTICS_ENABLED ? 'GET /' : 'GET'
      await assertDelegatedSampling(resource, 2, 'root')
    })

    it('uses the method when an Express root handler clears the route tag', async () => {
      await assertDelegatedSampling('GET', 2, 'rootWithoutTag')
    })

    it('reports the route of terminal Express middleware', async () => {
      const priority = createConfig().DD_TRACE_OTEL_SEMANTICS_ENABLED ? 2 : -1
      await assertDelegatedSampling('GET /health', priority, 'terminalUse')
    })

    for (const expressVersion of ['4.0.0', '4', '5']) {
      it(`replaces the outer route when Express ${expressVersion} matches the root in an array`, async () => {
        await assertDelegatedSampling(/^GET \/\*$/, -1, 'rootArray', expressVersion)
      })
    }
  })
})
