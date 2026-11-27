'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createRequire } = require('node:module')

const { after, afterEach, before, describe, it } = require('mocha')
const semver = require('semver')

const createConfig = require('../../dd-trace/src/config')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

const resource = 'GET /products/:id'

describe('Koa resource selection', () => {
  let server
  let tracer

  before(async () => {
    tracer = await agent.load(['koa', 'http'], [{ middleware: false }, { client: false }], {
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
    })
  })

  afterEach(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve))
      server = undefined
    }
  })

  after(() => agent.close())

  function inject () {
    return tracer.trace('outbound', span => {
      const carrier = {}
      tracer.inject(span, 'http_headers', carrier)
      return carrier['x-datadog-sampling-priority']
    })
  }

  /** @param {string} resource */
  function assertRejectedTrace (resource) {
    return agent.assertUserRejectedTrace(resource)
  }

  withVersions('koa', 'koa', (koaVersion, _koaModule, resolvedKoaVersion) => {
    withVersions('koa', 'koa-route', routeVersion => {
      for (const continues of [false, true]) {
        const name = continues ? 'defers until a later koa-route continuation' : 'uses the terminal koa-route path'
        it(`${name} without a router package`, async () => {
          const Koa = require(`../../../versions/koa@${koaVersion}`).get()
          const koaRoute = require(`../../../versions/koa-route@${routeVersion}`).get()
          const app = new Koa()
          if (continues) {
            app.use(koaRoute.get('/products/:id', (ctx, _productId, next) => {
              ctx.state.priority = inject()
              return next()
            }))
          }
          app.use(koaRoute.get('/products/:productId', ctx => {
            ctx.body = { priority: ctx.state.priority ?? inject() }
          }))

          server = app.listen(0, '127.0.0.1')
          await once(server, 'listening')
          const url = `http://127.0.0.1:${server.address().port}/products/12345`
          const route = 'GET /products/:productId'
          const [{ data }] = await Promise.all([
            httpRequest.get(url),
            continues
              ? assertRejectedTrace(route)
              : agent.assertFirstTraceSpan({ resource: route, metrics: { _sampling_priority_v1: 2 } }),
          ])
          assert.deepStrictEqual(data, { priority: continues ? '-1' : '2' })
        })
      }
    })

    withVersions('koa', ['koa-router', '@koa/router'], (routerVersion, moduleName, resolvedVersion) => {
      before(function () {
        if (moduleName === '@koa/router' && semver.gte(resolvedVersion, '15.0.0') &&
            Array.prototype.toReversed === undefined) {
          this.skip()
        }
      })

      async function request (mode, { headers, koaRoute } = {}) {
        const koaFixture = require(`../../../versions/koa@${koaVersion}`)
        const Koa = koaFixture.get()
        const Router = require(`../../../versions/${moduleName}@${routerVersion}`).get()
        const reversedMount = mode === 'reversed mount'
        const consumedMount = mode === 'consumed mount'
        const appendedMount = mode === 'late appended mount'
        const methodsAfterMount = mode === 'wrapped later mount before allowedMethods'
        const methodsBeforeMount = mode === 'allowedMethods before wrapped later mount'
        const wrappedLaterMount = mode === 'wrapped later mount' || appendedMount || methodsAfterMount ||
          methodsBeforeMount
        const laterMount = mode === 'later mount' || reversedMount || consumedMount || wrappedLaterMount
        const boundNested = mode === 'bound same-layer router'
        const nestedOnLayer = mode === 'direct same-layer router' || boundNested
        let appOptions
        if (reversedMount) {
          const requireFromKoa = createRequire(koaFixture.getPath())
          const nativeCompose = requireFromKoa('koa-compose')
          appOptions = {
            /** @param {import('koa').Middleware[]} stack */
            compose (stack) {
              assert.strictEqual(this, app)
              return nativeCompose(stack.slice().reverse())
            },
          }
        }
        const app = new Koa(appOptions)
        const exclusive = mode === 'exclusive' || mode === 'wrapped dispatch'
        const router = new Router(exclusive ? { exclusive: true } : undefined)
        const regexpContinuation = mode === 'regexp continuation'
        const regexp = mode === 'regexp' || regexpContinuation

        if (!regexp) {
          router.use('/products', (ctx, next) => {
            if (mode === 'prefix') ctx.state.priority = inject()
            return next()
          })
        }
        let path = '/products/:id'
        if (mode === 'root') path = '/'
        if (regexp) path = /^\/products\/[0-9]+$/
        if (mode === 'same path' || exclusive || laterMount) path = '/products/12345'
        if (mode === 'route override' || mode === 'koa-route') path = '/products/:sku'
        let detached
        if (mode === 'before any dispatch' || mode === 'outside matched chain') {
          const other = new Router()
          other.get('detached', mode === 'before any dispatch' ? path : '/', propagate)
          detached = other.route('detached').stack[0]
        }
        const handle = (ctx, next) => {
          if (mode === 'outside matched chain') {
            return detached(ctx, next)
          }
          if (mode === 'middleware appended during dispatch') {
            assert.strictEqual(app.middleware.length, 1)
            app.use(koaRoute.get('/products/:laterId', propagate))
            ctx.state.priority = inject()
            return next()
          }
          if (mode === 'same path' || mode === 'app middleware' || consumedMount) {
            return next()
          }
          if (regexpContinuation || mode === 'superseded' || mode === 'overlap' || mode === 'later prefix' ||
              laterMount || nestedOnLayer) {
            ctx.state.priority = inject()
            return next()
          }
          const span = tracer.scope().active()
          if (mode === 'explicit') span.setTag('resource.name', 'products.show')
          if (mode === 'route override') span.setTag('http.route', '/inventory/:id')
          if (mode === 'method rewrite') ctx.method = 'POST'
          if (mode === 'matches cleared') ctx.matched.length = 0

          if (mode === 'finish') {
            ctx.body = {}
          } else {
            const body = { priority: ctx.state.priority ?? inject() }
            if (mode === 'route override') body.route = span.context().getTag('http.route')
            ctx.body = body
          }
        }
        /**
         * @param {string} _value
         * @param {import('koa').Context} ctx
         * @param {import('koa').Next} next
         */
        function injectInParam (_value, ctx, next) {
          ctx.state.priority = inject()
          return next()
        }

        if (mode === 'param before route') router.param('id', injectInParam)
        if (exclusive) router.get('/products/:id', () => {})
        if (mode === 'koa-route continuation') {
          const first = koaRoute.get('/products/:id', (ctx, id, next) => {
            ctx.state.priority = inject()
            return next()
          })
          router.get(path, first, koaRoute.get('/products/:productId', propagate))
        } else if (nestedOnLayer) {
          const nested = new Router({ routerPath: '/products/12345' })
          nested.get('/products/12345', propagate)
          const dispatch = nested.routes()
          router.get(path, handle, boundNested ? dispatch.bind(undefined) : dispatch)
        } else if (mode === 'nested dispatch') {
          const nested = new Router()
          nested.get(path, (ctx, next) => next())
          router.get(path, nested.routes(), handle)
          router.get('/products/12345', () => {})
        } else if (mode === 'nested early' || mode === 'nested same route' || mode === 'nested resumed') {
          const nested = new Router({ routerPath: '/products/12345' })
          nested.get(path, (ctx, next) => {
            if (mode !== 'nested resumed') {
              ctx.state.priority = inject()
            }
            return next()
          })
          const nestedDispatch = nested.routes()
          router.use((ctx, next) => nestedDispatch(ctx, next))
          router.get(mode === 'nested same route' ? path : '/products/12345', propagate)
        } else if (mode === 'lowercase method') {
          router.register(path, ['get'], [handle], {})
        } else {
          router.get(path, handle)
        }
        if (mode === 'param after route') router.param('id', injectInParam)
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
          router.head('/products/12345', () => {})
          router.post('/products/12345', () => {})
        }
        if (regexpContinuation) router.get('/products/:productId', propagate)

        /** @param {import('koa').Context} ctx */
        function propagate (ctx) {
          ctx.body = { priority: ctx.state.priority ?? inject() }
        }

        if (mode === 'same path') router.use(path, propagate)
        if (mode === 'later prefix') router.use('/products', propagate)
        if (mode === 'koa-route') {
          app.use(koaRoute.get('/products/:productId', (ctx, productId, next) => next()))
        }
        const dispatch = router.routes()
        let laterDispatch
        if (laterMount) {
          const later = new Router()
          later.get('/products/:productId', propagate)
          laterDispatch = later.middleware()
        }
        if (reversedMount) {
          app.use(laterDispatch)
        }
        if (mode === 'preceding mount miss') {
          const preceding = new Router()
          preceding.get('/unmatched', () => {})
          app.use(preceding.routes())
        }
        if (mode === 'wrapped dispatch') {
          const preceding = new Router()
          preceding.get('/products/:id', (ctx, next) => next())
          app.use(preceding.routes())
          app.use((ctx, next) => dispatch(ctx, next))
        } else if (mode === 'before any dispatch') {
          app.use(detached)
        } else {
          if (mode === 'different displayed route') {
            const preceding = new Router()
            preceding.get('/products/:productId', (ctx, next) => next())
            app.use(preceding.routes())
          }
          app.use(mode === 'middleware only' ? propagate : dispatch)
        }
        if (mode === 'app middleware') app.use(propagate)
        if (mode === 'decorated middleware') {
          const later = new Router()
          later.get('/products/:productId', propagate)
          app.use(Object.assign(later.allowedMethods(), { router: later }))
        }
        const laterMiddleware = wrappedLaterMount ? (ctx, next) => laterDispatch(ctx, next) : laterDispatch
        if (methodsBeforeMount) app.use(router.allowedMethods())
        if (laterMount && !reversedMount && !appendedMount) {
          app.use(laterMiddleware)
        }
        if (methodsAfterMount) app.use(router.allowedMethods())
        server = app.listen(0, '127.0.0.1')
        if (appendedMount) app.use(laterMiddleware)
        await once(server, 'listening')
        const url = `http://127.0.0.1:${server.address().port}`
        const response = await httpRequest.get(url + (mode === 'root' ? '/' : '/products/12345'), { headers })
        return response.data
      }

      it('matches the resource rule at finish without propagation', async () => {
        await Promise.all([
          request('finish'),
          agent.assertFirstTraceSpan({ resource, metrics: { '_dd.rule_psr': 1, _sampling_priority_v1: 2 } }),
        ])
      })

      it('preserves the method fallback without router dispatch', async () => {
        const { DD_TRACE_OTEL_SEMANTICS_ENABLED: otel } = createConfig()
        const [body] = await Promise.all([
          request('middleware only'),
          otel
            ? agent.assertFirstTraceSpan({ resource: 'GET', metrics: { _sampling_priority_v1: 2 } })
            : assertRejectedTrace('GET'),
        ])
        assert.deepStrictEqual(body, { priority: otel ? '2' : '-1' })
      })

      it('falls back when nested dispatch leaves the current layer ambiguous', async () => {
        assert.deepStrictEqual(await request('nested dispatch'), { priority: '-1' })
      })

      for (const mode of ['direct same-layer router', 'bound same-layer router']) {
        it(`defers while a ${mode} is pending`, async () => {
          const [body] = await Promise.all([
            request(mode),
            assertRejectedTrace('GET /products/:id/products/12345'),
          ])
          assert.deepStrictEqual(body, { priority: '-1' })
        })
      }

      for (const mode of ['before any dispatch', 'outside matched chain']) {
        it(`does not sample a detached layer ${mode}`, async () => {
          assert.deepStrictEqual(await request(mode), { priority: '-1' })
        })
      }

      const pendingRoutes = [
        'regexp continuation',
        'nested early',
        'later mount',
        'wrapped later mount',
        'wrapped later mount before allowedMethods',
        'allowedMethods before wrapped later mount',
        'late appended mount',
      ]
      if (semver.gte(resolvedKoaVersion, '3.0.0')) {
        pendingRoutes.push('reversed mount')
      }
      for (const mode of pendingRoutes) {
        it(`does not sample ahead of a later route with ${mode}`, async () => {
          const selectedResource = mode === 'nested early' ? 'GET /products/12345' : 'GET /products/:productId'
          const [body] = await Promise.all([
            request(mode),
            assertRejectedTrace(selectedResource),
          ])
          assert.deepStrictEqual(body, { priority: '-1' })
        })
      }

      const consumedMounts = [
        ['consumed mount', 'GET /products/:productId'],
        ['preceding mount miss', resource],
      ]
      for (const [mode, selectedResource] of consumedMounts) {
        it(`samples the selected route with ${mode}`, async () => {
          const [body] = await Promise.all([
            request(mode),
            agent.assertFirstTraceSpan({
              resource: selectedResource,
              metrics: { '_dd.rule_psr': 1, _sampling_priority_v1: 2 },
            }),
          ])
          assert.deepStrictEqual(body, { priority: '2' })
        })
      }

      it('defers inside nested dispatch while the outer handler is pending on the same route', async () => {
        const [body] = await Promise.all([
          request('nested same route'),
          assertRejectedTrace(resource),
        ])
        assert.deepStrictEqual(body, { priority: '-1' })
      })

      it('samples the selected outer route after nested dispatch', async () => {
        const [body] = await Promise.all([
          request('nested resumed'),
          agent.assertFirstTraceSpan({
            resource: 'GET /products/12345',
            metrics: { '_dd.rule_psr': 1, _sampling_priority_v1: 2 },
          }),
        ])
        assert.deepStrictEqual(body, { priority: '2' })
      })

      for (const mode of ['later prefix', 'param before route', 'param after route']) {
        it(`defers with ${mode} while a later handler can still run`, async () => {
          const [body] = await Promise.all([
            request(mode),
            assertRejectedTrace(resource),
          ])
          assert.deepStrictEqual(body, { priority: '-1' })
        })
      }

      it('does not sample a template different from the displayed route', async () => {
        assert.deepStrictEqual(await request('different displayed route'), { priority: '-1' })
      })

      it('does not sample using a superseded route', async () => {
        const [body] = await Promise.all([
          request('superseded'),
          assertRejectedTrace('GET /products/12345'),
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

      it('keeps the selected route before middleware with a router property', async () => {
        const [body] = await Promise.all([
          request('decorated middleware'),
          agent.assertFirstTraceSpan({ resource, metrics: { '_dd.rule_psr': 1, _sampling_priority_v1: 2 } }),
        ])
        assert.deepStrictEqual(body, { priority: '2' })
      })

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
        const { DD_TRACE_OTEL_SEMANTICS_ENABLED: otel } = createConfig()
        const [body] = await Promise.all([
          request('method rewrite'),
          otel
            ? agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } })
            : assertRejectedTrace('POST /products/:id'),
        ])
        assert.deepStrictEqual(body, { priority: otel ? '2' : '-1' })
      })

      withVersions('koa', 'koa-route', routeVersion => {
        it('defers a koa-route path while a later handler is pending in the router', async () => {
          const koaRoute = require(`../../../versions/koa-route@${routeVersion}`).get()
          const [body] = await Promise.all([
            request('koa-route continuation', { koaRoute }),
            assertRejectedTrace('GET /products/:productId'),
          ])
          assert.deepStrictEqual(body, { priority: '-1' })
        })

        it('defers sampling when koa-route middleware is appended during dispatch', async () => {
          const koaRoute = require(`../../../versions/koa-route@${routeVersion}`).get()
          const [data] = await Promise.all([
            request('middleware appended during dispatch', { koaRoute }),
            assertRejectedTrace('GET /products/:laterId'),
          ])
          assert.deepStrictEqual(data, { priority: '-1' })
        })

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
