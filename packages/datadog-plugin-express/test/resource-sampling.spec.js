'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createRequire } = require('node:module')

const { afterEach, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const createConfig = require('../../dd-trace/src/config')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

const mountedResource = 'GET /api/:tenant/items/:id'
const arrayResource = 'GET /items/:id'

describe('Express resource sampling', () => {
  withVersions('express', 'express', (version, _name, resolvedVersion) => {
    let server
    let tracer
    let express

    beforeEach(async () => {
      const pluginConfig = [{ client: false }, { middleware: false }, { middleware: false }]
      await agent.load(['http', 'express', 'router'], pluginConfig, {
        sampleRate: 0,
        rateLimit: -1,
        samplingRules: [
          { resource: 'GET /api', sampleRate: 1 },
          { resource: 'GET /api/:tenant', sampleRate: 1 },
          { resource: mountedResource, sampleRate: 1 },
          { resource: arrayResource, sampleRate: 1 },
          { resource: 'GET /api/items/:id', sampleRate: 1 },
          { resource: 'GET /api/skipped/:id', sampleRate: 1 },
          { resource: 'HEAD /api/skipped/:id', sampleRate: 1 },
          { resource: 'GET /probe/:id', sampleRate: 1 },
          { resource: 'GET /prefer/:productIdentifier', sampleRate: 1 },
          { resource: 'POST', sampleRate: 1 },
        ],
      })
      tracer = require('../../dd-trace')
      express = require(`../../../versions/express@${version}`).get()
    })

    afterEach(async () => {
      if (server) await new Promise(resolve => server.close(resolve))
      await agent.close()
    })

    function inject () {
      const carrier = {}
      tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
      return carrier['x-datadog-sampling-priority']
    }

    async function request (app, path, method = 'GET') {
      server = app.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const { data } = await httpRequest.request('http://127.0.0.1:' + server.address().port + path, { method })
      return data
    }

    it('uses the selected template including its mount in the handler', async () => {
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

    it('does not use a mount as a matched template before dispatch', async () => {
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
      const app = express()
      const router = express.Router()
      router.get('/skipped/:id', (req, res, next) => next('route'))
      router.use((req, res) => res.json({ priority: inject() }))
      app.use('/api', router)

      assert.deepStrictEqual(await request(app, '/api/skipped/42'), { priority: '-1' })
    })

    for (const stage of ['handler', 'parameter']) {
      it(`does not sample a shorter template the span will not export during ${stage}`, async () => {
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
      const app = express()
      app.param('productIdentifier', (req, res, next) => {
        req.propagatedPriority = inject()
        next()
      })
      app.get('/prefer/:id', (req, res, next) => next('route'))
      app.get('/prefer/:productIdentifier', (req, res) => res.json({ priority: req.propagatedPriority }))

      const resource = 'GET /prefer/:productIdentifier'
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

    it('uses only the native array selection during a parameter callback', async () => {
      const app = express()
      app.param('id', (req, res, next) => {
        req.propagatedPriority = inject()
        next()
      })
      app.get(['/unused', '/items/:id'], (req, res) => res.json({ priority: req.propagatedPriority }))

      let priority = -1
      if (semver.major(resolvedVersion) >= 5) {
        const requireExpress = createRequire(require(`../../../versions/express@${version}`).getPath())
        if (semver.gte(requireExpress('router/package.json').version, '2.3.0')) priority = 2
      }

      const [propagated] = await Promise.all([
        request(app, '/items/42'),
        priority === 2
          ? agent.assertFirstTraceSpan({ resource: arrayResource, metrics: { _sampling_priority_v1: 2 } })
          : agent.assertUserRejectedTrace(arrayResource),
      ])
      assert.deepStrictEqual(propagated, { priority: String(priority) })
    })

    it('does not use a parameterized route without an HTTP server span', async () => {
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

    it('does not sample a route skipped by a parameter callback', async () => {
      const app = express()
      const router = express.Router()
      router.param('id', (req, res, next) => next('route'))
      router.get('/skipped/:id', (req, res) => res.status(500).end())
      router.use((req, res) => res.json({ priority: inject() }))
      app.use('/api', router)

      assert.deepStrictEqual(await request(app, '/api/skipped/42'), { priority: '-1' })
    })

    it('does not sample a parameterized path that does not handle HEAD', async () => {
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
  })
})
