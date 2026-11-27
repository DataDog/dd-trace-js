'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createRequire } = require('node:module')

const { afterEach, describe, it } = require('mocha')
const semver = require('semver')

const createConfig = require('../../dd-trace/src/config')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

const mountedResource = 'GET /api/:tenant/items/:id'
const arrayResource = 'GET /items/:id'

describe('Express resource sampling', () => {
  withVersions('express', 'express', (version, _name, resolvedVersion) => {
    const requireExpress = createRequire(require(`../../../versions/express@${version}`).getPath())
    const hasStandaloneRouter = semver.major(resolvedVersion) >= 5
    const usesPathToRegexp012 = !hasStandaloneRouter &&
      requireExpress('path-to-regexp/package.json').version === '0.1.2'
    const hasNativeArraySelection = hasStandaloneRouter &&
      semver.gte(requireExpress('router/package.json').version, '2.0.0')

    let server
    let tracer
    let express

    async function loadRules (...resources) {
      const pluginConfig = [{ client: false }, { middleware: false }, { middleware: false }]
      await agent.load(['http', 'express', 'router'], pluginConfig, {
        sampleRate: 0,
        rateLimit: -1,
        samplingRules: resources.map(resource => ({ resource, sampleRate: 1 })),
      })
      tracer = require('../../dd-trace')
      express = require(`../../../versions/express@${version}`).get()
    }

    afterEach(async () => {
      if (server) await new Promise(resolve => server.close(resolve))
      await agent.close()
    })

    function inject () {
      const carrier = {}
      tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
      return carrier['x-datadog-sampling-priority']
    }

    async function request (app, path, method = 'GET', headers = {}) {
      server = app.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const { data } = await httpRequest.request('http://127.0.0.1:' + server.address().port + path, { method, headers })
      return data
    }

    it('uses the selected template including its mount in the handler', async () => {
      await loadRules('GET /api/items/:id')
      const app = express()
      const router = express.Router()
      router.get('/items/:id', (req, res) => res.json({ priority: inject() }))
      app.use('/api', router)

      const [propagated] = await Promise.all([
        request(app, '/api/items/42'),
        agent.assertFirstTraceSpan({ resource: 'GET /api/items/:id', metrics: { _sampling_priority_v1: 2 } }),
      ])
      assert.deepStrictEqual(propagated, { priority: '2' })
    })

    it('samples the mounted template for an endpoint at the router root', async () => {
      await loadRules('GET /api')
      const app = express()
      const router = express.Router()
      router.get('/', (req, res) => res.json({ priority: inject() }))
      app.use('/api', router)

      const [propagated] = await Promise.all([
        request(app, '/api/'),
        agent.assertFirstTraceSpan({ resource: 'GET /api', metrics: { _sampling_priority_v1: 2 } }),
      ])
      assert.deepStrictEqual(propagated, { priority: '2' })
    })

    it('does not use a mount as a matched template before dispatch', async () => {
      await loadRules('GET /api')
      const app = express()
      const router = express.Router()
      app.use('/api', (req, res, next) => {
        req.propagatedPriority = inject()
        next()
      })
      router.get('/items/:id', (req, res) => res.json({ priority: req.propagatedPriority }))
      app.use('/api', router)

      assert.deepStrictEqual(await request(app, '/api/items/42'), { priority: '-1' })
    })

    it('does not match a route that fell through before propagation', async () => {
      await loadRules('GET /api/skipped/:id')
      const app = express()
      const router = express.Router()
      router.get('/skipped/:id', (req, res, next) => next('route'))
      router.use((req, res) => res.json({ priority: inject() }))
      app.use('/api', router)

      assert.deepStrictEqual(await request(app, '/api/skipped/42'), { priority: '-1' })
    })

    for (const stage of ['handler', 'parameter']) {
      it(`does not sample a shorter template the span will not export during ${stage}`, async () => {
        await loadRules('GET /probe/:id')
        const app = express()
        app.param('id', (req, res, next) => {
          if (stage === 'parameter') req.propagatedPriority = inject()
          next()
        })
        app.get('/probe/:productIdentifier', (req, res, next) => next('route'))
        app.get('/probe/:id', (req, res) => {
          res.json({ priority: stage === 'handler' ? inject() : req.propagatedPriority })
        })

        const [propagated] = await Promise.all([
          request(app, '/probe/42'),
          agent.assertUserRejectedTrace('GET /probe/:productIdentifier'),
        ])
        assert.deepStrictEqual(propagated, { priority: '-1' })
      })
    }

    it('keeps a more specific template selected during parameter processing', async () => {
      const resource = 'GET /prefer/:productIdentifier'
      await loadRules(resource)
      const app = express()
      app.param('productIdentifier', (req, res, next) => {
        req.propagatedPriority = inject()
        next()
      })
      app.get('/prefer/:id', (req, res, next) => next('route'))
      app.get('/prefer/:productIdentifier', (req, res) => res.json({ priority: req.propagatedPriority }))

      const priority = semver.gte(resolvedVersion, '4.5.0') ? 2 : -1
      const [propagated] = await Promise.all([
        request(app, '/prefer/42'),
        priority === 2
          ? agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } })
          : agent.assertUserRejectedTrace(resource),
      ])
      assert.deepStrictEqual(propagated, { priority: String(priority) })
    })

    it('preserves the published method-only resource in terminal middleware', async () => {
      await loadRules('POST')
      const app = express()
      app.use((req, res) => res.json({ priority: inject() }))

      const priority = createConfig().DD_TRACE_OTEL_SEMANTICS_ENABLED ? 2 : -1
      const [propagated] = await Promise.all([
        request(app, '/unknown', 'POST'),
        priority === 2
          ? agent.assertFirstTraceSpan({ resource: 'POST', metrics: { _sampling_priority_v1: 2 } })
          : agent.assertUserRejectedTrace('POST'),
      ])
      assert.deepStrictEqual(propagated, { priority: String(priority) })
    })

    it('uses the native selection when available while its parameter callback runs', async () => {
      await loadRules(mountedResource)
      const app = express()
      const router = express.Router()
      router.param('id', async (req, res, next) => {
        await Promise.resolve()
        req.propagatedPriority = inject()
        next()
      })
      router.get('/items/:id', (req, res) => res.json({ priority: req.propagatedPriority }))
      app.use('/api/:tenant', router)

      const priority = semver.satisfies(resolvedVersion, '>=4.5.0') ? 2 : -1
      const [propagated] = await Promise.all([
        request(app, '/api/acme/items/42'),
        priority === 2
          ? agent.assertFirstTraceSpan({ resource: mountedResource, metrics: { _sampling_priority_v1: 2 } })
          : agent.assertUserRejectedTrace(mountedResource),
      ])
      assert.deepStrictEqual(propagated, { priority: String(priority) })
    })

    const expressTemplate = '/items/:id'
    const koaTemplate = '/items/:productId'
    const explicitTemplate = '/declared/:id'
    const expressResource = 'GET ' + expressTemplate
    const koaResource = 'GET ' + koaTemplate
    for (const [otel, rule, stage, routeOverride] of [
      [false, expressResource, 'parameter callback', undefined],
      [false, koaResource, 'parameter callback', koaTemplate],
      [true, expressResource, 'parameter callback', undefined],
      [true, koaResource, 'parameter callback', undefined],
      [true, 'GET ' + explicitTemplate, 'route handler', explicitTemplate],
      [true, koaResource, 'route handler', explicitTemplate],
    ]) {
      const resource = 'GET ' + (routeOverride ?? koaTemplate)
      const priority = rule === resource ? 2 : -1
      const mode = otel ? 'OTel' : 'Datadog'
      const route = routeOverride === undefined ? 'framework route' : 'explicit route'
      it(`samples the ${route} when a ${stage} enters Koa (${mode}: ${rule})`, async function () {
        if (stage === 'parameter callback' && !semver.satisfies(resolvedVersion, '>=4.5.0')) {
          this.skip()
        }

        const previousSemantics = process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
        process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = String(otel)
        try {
          await loadRules(rule)
          tracer.use('koa', { middleware: false })

          const Koa = require('../../../versions/koa@2').get()
          const Router = require('../../../versions/@koa/router@12').get()
          const koa = new Koa()
          const router = new Router()
          router.get('/items/:productId', ctx => {
            ctx.body = { productId: ctx.params.productId, priority: inject() }
          })
          koa.use(router.routes())

          const app = express()
          const handleKoa = koa.callback()
          /**
           * @param {import('node:http').IncomingMessage} req
           * @param {import('node:http').ServerResponse} res
           */
          function delegateToKoa (req, res) {
            if (routeOverride !== undefined) {
              tracer.scope().active().setTag('http.route', routeOverride)
            }
            return handleKoa(req, res)
          }
          if (stage === 'parameter callback') {
            app.get('/items/:id', (_req, _res, next) => next('route'))
            app.param('productId', delegateToKoa)
            app.get('/items/:productId', (_req, res) => res.sendStatus(500))
          } else {
            app.get('/items/:id', delegateToKoa)
          }

          const [propagated] = await Promise.all([
            request(app, '/items/42'),
            priority === 2
              ? agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } })
              : agent.assertUserRejectedTrace(resource),
          ])
          assert.deepStrictEqual(propagated, { productId: '42', priority: String(priority) })
        } finally {
          if (previousSemantics === undefined) {
            delete process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
          } else {
            process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = previousSemantics
          }
        }
      })
    }

    it('uses only the native array selection during a parameter callback', async () => {
      await loadRules(arrayResource)
      const app = express()
      app.param('id', (req, res, next) => {
        req.propagatedPriority = inject()
        next()
      })
      app.get(['/unused', '/items/:id'], (req, res) => res.json({ priority: req.propagatedPriority }))

      const priority = hasNativeArraySelection ? 2 : -1

      const [propagated] = await Promise.all([
        request(app, '/items/42'),
        priority === 2
          ? agent.assertFirstTraceSpan({ resource: arrayResource, metrics: { _sampling_priority_v1: 2 } })
          : agent.assertUserRejectedTrace(arrayResource),
      ])
      assert.deepStrictEqual(propagated, { priority: String(priority) })
    })

    it('matches the reported resource during an array route handler', async () => {
      await loadRules(arrayResource)
      const app = express()
      app.get(['/unused', '/items/:id'], (req, res) => res.json({ priority: inject() }))

      const priority = hasNativeArraySelection || createConfig().DD_TRACE_OTEL_SEMANTICS_ENABLED ? '2' : '-1'
      assert.deepStrictEqual(await request(app, '/items/42'), { priority })
    })

    for (const stage of ['parameter callback', 'handler', 'static handler']) {
      for (const hasSibling of [false, true]) {
        // A standalone Router supplies the native grouped match.
        const alternatives = hasSibling ? 'with a sibling' : 'without a sibling'
        it(`samples the native grouped alternative ${alternatives} in its ${stage}`, async function () {
          if (!hasNativeArraySelection) {
            return this.skip()
          }

          const staticRoute = stage === 'static handler'
          const resource = staticRoute ? 'GET /items/42' : 'GET /items/:lowercase'
          await loadRules(resource)
          const app = express()
          const Router = require('../../../versions/router@2.2.0').get()
          const router = Router({ caseSensitive: true, strict: true })
          router.param('lowercase', (req, res, next) => {
            if (stage === 'parameter callback') {
              req.propagatedPriority = inject()
            }
            next()
          })
          const group = staticRoute ? ['/Items/42', '/items/42'] : ['/Items/:uppercase', '/items/:lowercase']
          const routes = [group]
          if (hasSibling) routes.push('/health')
          let registered = false
          Object.defineProperty(routes, 0, {
            get () {
              assert.strictEqual(registered, false)
              return group
            },
          })
          router.get(routes, (req, res) => {
            const priority = stage === 'parameter callback' ? req.propagatedPriority : inject()
            res.json({ lower: staticRoute ? '42' : req.params.lowercase, priority })
          })
          app.use(router)
          registered = true

          const [propagated] = await Promise.all([
            request(app, '/items/42'),
            agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } }),
          ])
          assert.deepStrictEqual(propagated, { lower: '42', priority: '2' })
        })
      }
    }

    // Router 2 exposes the native match before running parameter callbacks.
    it('keeps a grouped match across nested dispatch and overlapping requests', async function () {
      if (!hasNativeArraySelection) return this.skip()

      await loadRules('GET /items/:lowercase')
      const app = express()
      const Router = require('../../../versions/router@2.2.0').get()
      const inner = Router()
      inner.get(['/unused/:child', '/items/:child'], (req, res, next) => next('route'))

      let notify
      const paused = new Promise(resolve => { notify = resolve })
      let resume
      const resumed = new Promise(resolve => { resume = resolve })
      const outer = Router()
      outer.param('lowercase', (req, res, next) => {
        inner(req, res, async error => {
          notify()
          if (error) return next(error)
          await resumed
          next()
        })
      })
      outer.get([['/items/:lowercase', '/alternatives/:alternate']], (req, res) => {
        res.json({ params: req.params, priority: inject() })
      })
      app.use(outer)

      server = app.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = 'http://127.0.0.1:' + server.address().port
      const [lower, alternate] = await Promise.all([
        httpRequest.get(address + '/items/42'),
        (async () => {
          await paused
          try {
            return await httpRequest.get(address + '/alternatives/43')
          } finally {
            resume()
          }
        })(),
      ])

      assert.deepStrictEqual(lower.data, { params: { lowercase: '42' }, priority: '2' })
      assert.deepStrictEqual(alternate.data, { params: { alternate: '43' }, priority: '-1' })
    })

    // Nested arrays require the later Express 4 path compiler.
    it('keeps legacy grouped paths pending in a parameter callback', async function () {
      if (hasStandaloneRouter || usesPathToRegexp012 || semver.lt(resolvedVersion, '4.5.0')) return this.skip()

      await loadRules('GET /Items/:uppercase')
      const app = express()
      app.enable('case sensitive routing')
      app.param('lowercase', (req, res, next, lower) => res.json({ lower, priority: inject() }))
      app.get([['/Items/:uppercase', '/items/:lowercase']], (req, res) => res.sendStatus(500))
      assert.deepStrictEqual(await request(app, '/items/42'), { lower: '42', priority: '-1' })
    })

    it('does not let a legacy array regexp change the propagated priority', async function () {
      if (hasStandaloneRouter || usesPathToRegexp012 || createConfig().DD_TRACE_OTEL_SEMANTICS_ENABLED) {
        this.skip()
      }

      const pattern = /^\/items\/([0-9]+)$/g
      await loadRules(`GET (${pattern})`)
      const app = express()
      app.get([pattern, '/unused'], (req, res) => res.json({ priority: inject() }))

      assert.deepStrictEqual(await request(app, '/items/42'), { priority: '-1' })
      const url = 'http://127.0.0.1:' + server.address().port + '/items/42'
      const { data } = await httpRequest.request(url, { method: 'GET' })
      assert.deepStrictEqual(data, { priority: '-1' })
    })

    it('uses the native regexp from an array during a parameter callback', async function () {
      if (usesPathToRegexp012) {
        this.skip()
      }

      const pattern = /^\/items\/([0-9]+)$/
      const resource = `GET (${pattern})`
      await loadRules(resource)
      const app = express()
      app.param('0', (req, res, next, value) => {
        req.propagatedPriority = inject()
        req.observedCapture = value
        next()
      })
      app.get(['/unused', pattern], (req, res) => {
        res.json({ priority: req.propagatedPriority, capture: req.observedCapture })
      })

      const priority = hasNativeArraySelection ? 2 : -1
      const [propagated] = await Promise.all([
        request(app, '/items/42'),
        priority === 2
          ? agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } })
          : agent.assertUserRejectedTrace(resource),
      ])
      assert.deepStrictEqual(propagated, { priority: String(priority), capture: '42' })
    })

    it('does not turn a wildcard capture into a sampling route', async function () {
      if (hasStandaloneRouter || usesPathToRegexp012) {
        this.skip()
      }

      await loadRules('GET /items/42')
      const app = express()
      app.param('0', (req, res, next) => {
        req.propagatedPriority = inject()
        next()
      })
      app.get('*', (req, res) => {
        res.json({ priority: req.propagatedPriority, capture: req.params[0] })
      })

      const [propagated] = await Promise.all([
        request(app, '/items/42'),
        agent.assertUserRejectedTrace('GET'),
      ])
      assert.deepStrictEqual(propagated, { priority: '-1', capture: '/items/42' })
    })

    it('does not use a parameterized route without an HTTP server span', async () => {
      await loadRules(arrayResource)
      tracer.use('http', false)
      const app = express()
      app.param('id', (req, res, next) => {
        req.propagatedPriority = inject()
        next()
      })
      app.get('/items/:id', (req, res) => res.json({ priority: req.propagatedPriority }))

      const [propagated] = await Promise.all([
        request(app, '/items/42'),
        agent.assertUserRejectedTrace('outbound'),
      ])
      assert.deepStrictEqual(propagated, { priority: '-1' })
    })

    it('does not sample a parameterized prefix as the route', async () => {
      await loadRules('GET /api/:tenant', mountedResource)
      const app = express()
      const router = express.Router()
      app.param('tenant', (req, res, next) => {
        req.propagatedPriority = inject()
        next()
      })
      router.get('/items/:id', (req, res) => res.json({ priority: req.propagatedPriority }))
      app.use('/api/:tenant', router)

      assert.deepStrictEqual(await request(app, '/api/acme/items/42'), { priority: '-1' })
    })

    for (const destination of ['middleware', 'router completion']) {
      it(`does not sample a skipped parameterized route in ${destination}`, async () => {
        await loadRules('GET /api/skipped/:id')
        const app = express()
        const router = express.Router()
        router.param('id', (req, res, next) => next('route'))
        router.get('/skipped/:id', (req, res) => res.status(500).end())

        /**
         * @param {import('express').Request} _req
         * @param {import('express').Response} res
         */
        function propagate (_req, res) {
          res.json({ priority: inject() })
        }

        if (destination === 'middleware') {
          router.use(propagate)
          app.use('/api', router)
        } else {
          app.use('/api', (req, res) => router(req, res, error => {
            assert.ifError(error)
            propagate(req, res)
          }))
        }

        assert.deepStrictEqual(await request(app, '/api/skipped/42'), { priority: '-1' })
      })
    }

    it('does not sample a parameterized path that does not handle HEAD', async () => {
      await loadRules('HEAD /api/skipped/:id')
      const app = express()
      const router = express.Router()
      let priority
      router.param('id', (req, res, next) => {
        priority = inject()
        next()
      })
      router.post('/skipped/:id', (req, res) => res.status(500).end())
      router.use((req, res) => res.status(204).end())
      app.use('/api', router)

      await request(app, '/api/skipped/42', 'HEAD')
      assert.strictEqual(priority, '-1')
    })

    it('does not sample a parameterized route after res.format forwards an error', async () => {
      await loadRules('GET /items/:id')
      const app = express()
      app.param('id', (req, res) => res.format({ 'text/plain': () => res.send('unexpected') }))
      app.get('/items/:id', (req, res) => res.json({ priority: inject() }))
      app.use((error, req, res, next) => {
        res.json({ status: error.status ?? error.statusCode, priority: inject() })
      })

      const response = await request(app, '/items/42', 'GET', { accept: 'application/json' })
      assert.deepStrictEqual(response, { status: 406, priority: '-1' })
    })

    it('does not sample an abandoned parameterized route in a nested router callback', async function () {
      if (semver.lt(resolvedVersion, '4.5.0')) {
        this.skip()
      }

      await loadRules('GET /api/items/:id')
      const app = express()
      const router = express.Router()
      router.param('id', (req, res) => res.format({ 'text/plain': () => res.send('unexpected') }))
      router.get('/items/:id', (req, res) => res.status(500).end())
      app.use('/api', (req, res) => router(req, res, error => {
        res.json({ status: error.status ?? error.statusCode, priority: inject() })
      }))

      const response = await request(app, '/api/items/42', 'GET', { accept: 'application/json' })
      assert.strictEqual(response.priority, '-1')
      assert.strictEqual(response.status, 406)
    })

    it('samples the selected standalone Router array route before its handler', async () => {
      const resource = 'GET /items/:inner'
      await loadRules(resource)
      const app = express()
      const Router = require('../../../versions/router@2.2.0').get()
      const router = Router()
      router.param('inner', (req, res, next, id) => res.json({ id, priority: inject() }))
      router.get(['/unused/:inner', '/items/:inner'], (req, res) => res.sendStatus(500))
      app.use(router)

      const [propagated] = await Promise.all([
        request(app, '/items/42'),
        agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } }),
      ])
      assert.deepStrictEqual(propagated, { id: '42', priority: '2' })
    })

    for (const [outerPhase, fallthrough] of [
      ['parameter', 'parameter'],
      ['handler', 'parameter'],
      ['parameter', 'handler'],
      ['handler', 'handler'],
      ['parameter', 'middleware'],
      ['parameter', 'resumed handler'],
      ['parameter', 'nested handler'],
      ['parameter', 'tagged handler'],
      ['parameter', undefined],
    ]) {
      const selectsInner = fallthrough === undefined
      const title = selectsInner
        ? 'uses the selected nested route'
        : `resumes the outer ${outerPhase} route after the inner ${fallthrough} falls through`
      it(title,
        async function () {
          if (outerPhase === 'parameter' && semver.lt(resolvedVersion, '4.5.0')) {
            this.skip()
          }

          const override = fallthrough === 'tagged handler' ? '/manually-selected' : undefined
          const resource = 'GET ' + (override ?? (selectsInner ? '/items/:inner' : '/items/:id'))
          await loadRules(resource)
          const app = express()
          const Router = require('../../../versions/router@2.2.0').get()
          const router = Router()
          let id
          router.param('inner', (req, res, next, value) => {
            id = value
            next(fallthrough === 'parameter' ? 'route' : undefined)
          })
          const nested = fallthrough === 'nested handler' ? Router() : undefined
          if (nested) nested.get('/items/:deep', (req, res, next) => next('route'))
          const resumesHandler = fallthrough === 'resumed handler'
          if (fallthrough === 'middleware' || resumesHandler) {
            router.use('/items/:inner', (req, res, next) => {
              id = req.params.inner
              next()
            })
          } else {
            router.get(['/unused/:inner', '/items/:inner'], (req, res, next) => {
              if (nested) return nested(req, res, error => next(error ?? 'route'))
              if (override) {
                tracer.scope().active().setTag('http.route', override)
                return next('route')
              }
              if (fallthrough === 'handler') return next('route')
              res.json({ id, priority: inject() })
            })
          }

          function delegate (req, res, next) {
            router(req, res, error => {
              assert.ifError(error)
              if (resumesHandler) return next()
              res.json({ id, priority: inject() })
            })
          }

          if (outerPhase === 'parameter') {
            app.param('id', delegate)
            app.get('/items/:id', (req, res) => {
              if (resumesHandler) return res.json({ id: req.params.id, priority: inject() })
              res.sendStatus(500)
            })
          } else {
            app.get('/items/:id', delegate)
          }

          const [propagated] = await Promise.all([
            request(app, '/items/42'),
            agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } }),
          ])
          assert.deepStrictEqual(propagated, { id: '42', priority: '2' })
        })
    }

    for (const mount of ['', '/api']) {
      it(`reports the sampled route when a parameter callback ends the response at ${mount || '/'}`, async function () {
        const hasNativeSelection = semver.gte(resolvedVersion, '4.5.0')
        if (mount && !hasNativeSelection) {
          this.skip()
        }

        const route = `${mount}/items/:id`
        const resource = `GET ${route}`
        await loadRules(resource)
        const app = express()
        const router = mount ? express.Router() : app
        router.param('id', (req, res) => res.json({ priority: inject() }))
        router.get('/items/:id', (req, res) => res.send('unexpected'))
        if (mount) {
          app.use(mount, router)
        }

        const [propagated] = await Promise.all([
          request(app, `${mount}/items/42`),
          hasNativeSelection
            ? agent.assertFirstTraceSpan({
              resource,
              metrics: { _sampling_priority_v1: 2 },
              meta: { 'http.route': route },
            })
            : agent.assertUserRejectedTrace('GET'),
        ])
        assert.deepStrictEqual(propagated, { priority: hasNativeSelection ? '2' : '-1' })
      })
    }

    it('preserves an explicit route when a parameter callback ends the response', async () => {
      await loadRules('GET /manual')
      const app = express()
      app.param('id', (req, res) => {
        tracer.scope().active().setTag('http.route', '/manual')
        res.json({ priority: inject() })
      })
      app.get('/items/:id', (req, res) => res.send('unexpected'))

      const [propagated] = await Promise.all([
        request(app, '/items/42'),
        agent.assertFirstTraceSpan({
          resource: 'GET /manual',
          metrics: { _sampling_priority_v1: 2 },
          meta: { 'http.route': '/manual' },
        }),
      ])
      assert.deepStrictEqual(propagated, { priority: '2' })
    })
  })
})
