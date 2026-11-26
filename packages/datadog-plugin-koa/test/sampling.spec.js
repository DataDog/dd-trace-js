'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { after, afterEach, before, describe, it } = require('mocha')
const semver = require('semver')

const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

const resource = 'GET /products/:id'

describe('Koa resource sampling', () => {
  before(() => agent.load(['koa', 'http'], [{ middleware: false }, { client: false }], {
    rateLimit: -1,
    sampleRate: 0,
    samplingRules: [
      { resource: 'GET', sampleRate: 1 },
      { resource, sampleRate: 1 },
      { resource: 'GET /products', sampleRate: 1 },
      { resource: 'GET /products/12345', sampleRate: 1 },
      { resource: 'GET /inventory/:id', sampleRate: 1 },
      { resource: 'GET /products/:productId', sampleRate: 1 },
    ],
  }))

  after(() => agent.close())

  withVersions('koa', 'koa', koaVersion => {
    withVersions('koa', ['koa-router', '@koa/router'], (routerVersion, moduleName, resolvedVersion) => {
      let server

      afterEach(async () => {
        if (server) await new Promise(resolve => server.close(resolve))
      })

      async function request (mode, { headers, koaRoute } = {}) {
        const tracer = require('../../dd-trace')
        const Koa = require(`../../../versions/koa@${koaVersion}`).get()
        const Router = require(`../../../versions/${moduleName}@${routerVersion}`).get()
        const app = new Koa()
        const exclusive = mode === 'exclusive' || mode === 'wrapped dispatch'
        const router = new Router(exclusive ? { exclusive: 'specificity' } : undefined)

        function inject () {
          return tracer.trace('outbound', span => {
            const carrier = {}
            tracer.inject(span, 'http_headers', carrier)
            return carrier['x-datadog-sampling-priority']
          })
        }

        if (mode !== 'regexp') {
          router.use('/products', (ctx, next) => {
            if (mode === 'prefix') ctx.state.priority = inject()
            return next()
          })
        }
        let path = '/products/:id'
        if (mode === 'root') path = '/'
        if (mode === 'regexp') path = /^\/products\/[0-9]+$/
        if (mode === 'same path' || exclusive) path = '/products/12345'
        if (mode === 'route override' || mode === 'koa-route') path = '/products/:sku'
        const handle = (ctx, next) => {
          if (mode === 'same path' || mode === 'app middleware') return next()
          if (mode === 'superseded' || mode === 'overlap') {
            ctx.state.priority = inject()
            return next()
          }
          const span = tracer.scope().active()
          if (mode === 'explicit') span.setTag('resource.name', 'products.show')
          if (mode === 'route override') span.setTag('http.route', '/inventory/:id')
          if (mode === 'method rewrite') ctx.method = 'POST'
          if (mode === 'matches cleared') ctx.matched.length = 0

          if (mode === 'dbm') {
            const db = new DatabasePlugin(tracer, {})
            db.configure({ enabled: true, dbmPropagationMode: 'full' })
            ctx.body = tracer.trace('pg.query', query => ({ comment: db.createDbmComment(query, 'postgres') }))
          } else if (mode === 'finish') {
            ctx.body = {}
          } else {
            const body = { priority: ctx.state.priority ?? inject() }
            if (mode === 'route override') body.route = span.context().getTag('http.route')
            ctx.body = body
          }
        }
        if (mode === 'nested dispatch') {
          const nested = new Router()
          nested.get(path, (ctx, next) => next())
          router.get(path, nested.routes(), handle)
          router.get('/products/12345', () => {})
        } else if (mode === 'lowercase method') {
          router.register(path, ['get'], [handle], {})
        } else {
          router.get(path, handle)
        }
        if (mode === 'superseded') {
          router.use('/products/12345', ctx => {
            ctx.body = { priority: ctx.state.priority }
          })
        }
        if (mode === 'overlap') {
          router.get('/products/12345', ctx => {
            ctx.body = { priority: ctx.state.priority }
          })
        }
        if (mode === 'http') {
          router.get(path, () => {})
          router.head('/products/12345', () => {})
          router.post('/products/12345', () => {})
        }
        if (exclusive) router.get('/products/:id', () => {})
        if (mode === 'regexp') router.get(/^\/products\/\d+$/, () => {})

        function propagate (ctx) {
          ctx.body = { priority: inject() }
        }

        if (mode === 'same path') router.use(path, propagate)
        if (koaRoute) app.use(koaRoute.get('/products/:productId', (ctx, productId, next) => next()))
        const dispatch = router.routes()
        if (mode === 'wrapped dispatch') {
          const preceding = new Router()
          preceding.get('/products/:id', (ctx, next) => next())
          app.use(preceding.routes())
          app.use((ctx, next) => dispatch(ctx, next))
        } else {
          if (mode === 'different displayed route') {
            const preceding = new Router()
            preceding.get('/products/:productId', (ctx, next) => next())
            app.use(preceding.routes())
          }
          app.use(dispatch)
        }
        if (mode === 'app middleware') app.use(propagate)
        server = app.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const url = `http://127.0.0.1:${server.address().port}`
        const response = await httpRequest.get(url + (mode === 'root' ? '/' : '/products/12345'), { headers })
        return response.data
      }

      it('matches the resource rule when propagating HTTP headers', async () => {
        const [body] = await Promise.all([
          request('http'),
          agent.assertFirstTraceSpan({ resource, metrics: { '_dd.rule_psr': 1, _sampling_priority_v1: 2 } }),
        ])
        assert.deepStrictEqual(body, { priority: '2' })
      })

      it('matches the resource rule in full DBM mode', async () => {
        const [body] = await Promise.all([
          request('dbm'),
          agent.assertFirstTraceSpan({ resource, metrics: { '_dd.rule_psr': 1, _sampling_priority_v1: 2 } }),
        ])
        assert.match(body.comment, /traceparent='00-[a-f0-9]{32}-[a-f0-9]{16}-01'/)
      })

      it('matches the resource rule at finish without propagation', async () => {
        await Promise.all([
          request('finish'),
          agent.assertFirstTraceSpan({ resource, metrics: { '_dd.rule_psr': 1, _sampling_priority_v1: 2 } }),
        ])
      })

      it('does not treat a middleware prefix as the resource', async () => {
        assert.deepStrictEqual(await request('prefix'), { priority: '-1' })
      })

      it('falls back when nested dispatch leaves the current layer ambiguous', async () => {
        assert.deepStrictEqual(await request('nested dispatch'), { priority: '-1' })
      })

      it('does not sample a template different from the displayed route', async () => {
        assert.deepStrictEqual(await request('different displayed route'), { priority: '-1' })
      })

      it('does not sample using a superseded route', async () => {
        const [body] = await Promise.all([
          request('superseded'),
          agent.assertUserRejectedTrace('GET /products/12345'),
        ])
        assert.deepStrictEqual(body, { priority: '-1' })
      })

      it('does not guess which overlapping route will handle the request', async () => {
        const [body] = await Promise.all([
          request('overlap'),
          agent.assertUserRejectedTrace('GET /products/12345'),
        ])
        assert.deepStrictEqual(body, { priority: '-1' })
      })

      for (const mode of ['matches cleared', 'lowercase method']) {
        it(`uses the native dispatch with ${mode}`, async () => {
          assert.deepStrictEqual(await request(mode), { priority: '2' })
        })
      }

      for (const mode of ['root', 'regexp']) {
        it(`matches a method-only resource for a ${mode} route`, async () => {
          const [body] = await Promise.all([
            request(mode),
            agent.assertFirstTraceSpan({ resource: 'GET', metrics: { '_dd.rule_psr': 1, _sampling_priority_v1: 2 } }),
          ])
          assert.deepStrictEqual(body, { priority: '2' })
        })
      }

      for (const mode of ['same path', 'app middleware']) {
        it(`keeps the resolved resource through ${mode} middleware`, async () => {
          assert.deepStrictEqual(await request(mode), { priority: '2' })
        })
      }

      if (moduleName === '@koa/router' && semver.satisfies(resolvedVersion, '>=15')) {
        for (const mode of ['exclusive', 'wrapped dispatch']) {
          it(`uses the chosen route with ${mode}`, async () => {
            const [body] = await Promise.all([
              request(mode),
              agent.assertFirstTraceSpan({
                resource: 'GET /products/12345',
                metrics: { '_dd.rule_psr': 1, _sampling_priority_v1: 2 },
              }),
            ])
            assert.deepStrictEqual(body, { priority: '2' })
          })
        }
      }

      it('matches the method used to export the HTTP resource', async () => {
        const createConfig = require('../../dd-trace/src/config')
        const { DD_TRACE_OTEL_SEMANTICS_ENABLED: otel } = createConfig()
        const [body] = await Promise.all([
          request('method rewrite'),
          otel
            ? agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } })
            : agent.assertUserRejectedTrace('POST /products/:id'),
        ])
        assert.deepStrictEqual(body, { priority: otel ? '2' : '-1' })
      })

      withVersions('koa', 'koa-route', routeVersion => {
        it('prefers the live koa-route path when it delegates to a router', async () => {
          const koaRoute = require(`../../../versions/koa-route@${routeVersion}`).get()
          const [body] = await Promise.all([
            request('koa-route', { koaRoute }),
            agent.assertFirstTraceSpan({
              resource: 'GET /products/:productId',
              metrics: { '_dd.rule_psr': 1, _sampling_priority_v1: 2 },
            }),
          ])
          assert.deepStrictEqual(body, { priority: '2' })
        })
      })

      it('prefers an explicit resource name', async () => {
        assert.deepStrictEqual(await request('explicit'), { priority: '-1' })
      })

      it('uses the current http.route when formatting the sampling resource', async () => {
        const [body] = await Promise.all([
          request('route override'),
          agent.assertFirstTraceSpan({
            resource: 'GET /inventory/:id',
            metrics: { '_dd.rule_psr': 1, _sampling_priority_v1: 2 },
          }),
        ])
        assert.deepStrictEqual(body, { priority: '2', route: '/inventory/:id' })
      })

      it('preserves an incoming sampling priority', async () => {
        assert.deepStrictEqual(await request('http', {
          headers: {
            'x-datadog-trace-id': '42',
            'x-datadog-parent-id': '43',
            'x-datadog-sampling-priority': '0',
          },
        }), { priority: '0' })
      })
    })
  })
})
