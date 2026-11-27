'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { after, afterEach, before, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

const resource = 'GET /api/items/:id'

describe('Hono resource sampling', () => {
  for (const otel of [false, true]) {
    describe(otel ? 'with OTel semantics' : 'with Datadog semantics', () => registerSamplingTests(otel))
  }
})

/** @param {boolean} otel */
function registerSamplingTests (otel) {
  let previousSemantics

  before(async () => {
    previousSemantics = process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
    process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = String(otel)
    await agent.load(['hono', 'http'], [{ middleware: false }, { client: false }], {
      rateLimit: -1,
      sampleRate: 0,
      samplingRules: [
        { resource, sampleRate: 1 },
        { resource: /^GET \/mounted\/\*$/, sampleRate: 1 },
        { resource: 'GET', sampleRate: 1 },
      ],
    })
  })

  after(async () => {
    try {
      await agent.close()
    } finally {
      if (previousSemantics === undefined) {
        delete process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
      } else {
        process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = previousSemantics
      }
    }
  })

  withVersions('hono', 'hono', version => {
    let server

    afterEach(async () => {
      if (server) await new Promise(resolve => server.close(resolve))
      server = undefined
    })

    /**
     * @param {'single handler' | 'composed handlers' | 'before handler' | 'middleware only' | 'app request' |
     *   'grouped middleware' | 'grouped handler' | 'shared handler' | 'nested fetch' | 'clone entry' |
     *   'middleware after the endpoint' | 'hono/tiny' | 'hono/quick'} mode
     * @param {boolean} [customError]
     * @param {boolean} [outerMiddleware]
     */
    async function propagate (mode, customError = true, outerMiddleware = true) {
      const tracer = require('../../dd-trace')
      const fixture = require('../../../versions/hono@' + version)
      const preset = mode === 'hono/tiny' || mode === 'hono/quick'
      const { Hono } = preset ? fixture.get(mode) : fixture.get()
      const { serve } = require('../../../versions/@hono/node-server@1.15.0').get()
      const app = new Hono()
      const api = app.basePath('/api')
      const path = mode === 'nested fetch' ? '/mounted/items/42' : '/api/items/42'

      function inject () {
        const carrier = {}
        tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
        return carrier['x-datadog-sampling-priority']
      }

      if (mode === 'middleware only') {
        api.use(context => context.json({ priority: inject() }))
      } else if (mode === 'grouped middleware' || mode === 'grouped handler' || mode === 'shared handler') {
        const child = new Hono()
        const method = mode === 'grouped middleware' ? 'use' : 'all'
        const handler = (context, next) => {
          const middlewareSeen = context.get('middlewareSeen')
          if (mode === 'shared handler' && !middlewareSeen) {
            context.set('middlewareSeen', true)
            return next()
          }
          const priority = inject()
          return context.json(mode === 'shared handler' ? { priority, middlewareSeen } : { priority })
        }
        if (customError) {
          child.onError((error, context) => context.text(error.message, 500))
        }
        if (mode === 'shared handler') {
          child.use('/items/:id', handler)
        }
        child[method]('/items/:id', handler)
        app.route('/api', child)
      } else if (mode === 'nested fetch') {
        const child = new Hono()
        const passThrough = (_context, next) => next()
        child.use(passThrough)
        child.use(context => context.json({ priority: inject() }))
        if (outerMiddleware) app.use('/mounted/*', passThrough)
        app.mount('/mounted', child.fetch)
      } else if (mode === 'middleware after the endpoint') {
        api.get('/items/:id', (_context, next) => next())
        api.use('/items/:id', context => context.json({ priority: inject() }))
      } else {
        const beforeHandler = mode === 'before handler' || mode === 'clone entry'
        if (mode === 'composed handlers' || beforeHandler || preset) {
          api.use('/items/:id', (context, next) => {
            if (beforeHandler) context.set('priority', inject())
            return next()
          })
        }
        api.get('/items/:id', context => context.json({ priority: context.get('priority') ?? inject() }))
      }

      if (mode === 'app request') {
        const response = await app.request(path)
        assert.strictEqual(response.status, 200)
        return response.json()
      }

      const fetch = mode === 'clone entry' ? api.fetch : app.fetch
      server = serve({ fetch, port: 0, hostname: '127.0.0.1' })
      await once(server, 'listening')
      const { data } = await httpRequest.get('http://127.0.0.1:' + server.address().port + path)
      return data
    }

    for (const mode of ['single handler', 'composed handlers', 'grouped handler', 'middleware after the endpoint']) {
      it('samples the matched route with ' + mode, async () => {
        const [body] = await Promise.all([
          propagate(mode),
          agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } }),
        ])
        assert.deepStrictEqual(body, { priority: '2' })
      })
    }

    for (const customError of [false, true]) {
      it(`samples only the endpoint when it shares a handler with middleware (custom error handler: ${customError})`,
        async () => {
          const [body] = await Promise.all([
            propagate('shared handler', customError),
            agent.assertFirstTraceSpan({
              resource,
              metrics: { _sampling_priority_v1: 2 },
              meta: { 'http.route': '/api/items/:id' },
            }),
          ])
          assert.deepStrictEqual(body, { priority: '2', middlewareSeen: true })
        })
    }

    for (const preset of ['hono/tiny', 'hono/quick']) {
      it('preserves route attribution for ' + preset, async () => {
        const priority = otel ? 2 : -1
        const [body] = await Promise.all([
          propagate(preset),
          agent.assertFirstTraceSpan({
            resource,
            meta: { 'http.route': '/api/items/:id' },
            metrics: { _sampling_priority_v1: priority },
          }),
        ])
        assert.deepStrictEqual(body, { priority: String(priority) })
      })
    }

    it('does not sample the displayed route before the handler is entered', async () => {
      assert.deepStrictEqual(await propagate('before handler'), { priority: '-1' })
    })

    it('preserves the response when HTTP tracing is disabled', async () => {
      const tracer = require('../../dd-trace')
      tracer.use('http', { enabled: false })
      try {
        assert.deepStrictEqual(await propagate('single handler'), { priority: '-1' })
      } finally {
        tracer.use('http', { enabled: true, client: false })
      }
    })

    it('does not sample a clone route before the handler is entered', async () => {
      assert.deepStrictEqual(await propagate('clone entry'), { priority: '-1' })
    })

    it('does not sample grouped middleware as an endpoint', async () => {
      const [body] = await Promise.all([
        propagate('grouped middleware'),
        agent.assertUserRejectedTrace('GET'),
      ])
      assert.deepStrictEqual(body, { priority: '-1' })
    })

    for (const outerMiddleware of [true, false]) {
      it(`keeps a selected mount during nested fetch with outer middleware set to ${outerMiddleware}`, async () => {
        const [body] = await Promise.all([
          propagate('nested fetch', true, outerMiddleware),
          agent.assertFirstTraceSpan({ resource: 'GET /mounted/*', metrics: { _sampling_priority_v1: 2 } }),
        ])
        assert.deepStrictEqual(body, { priority: '2' })
      })
    }

    it('does not claim a selected route from middleware-only matches', async () => {
      assert.deepStrictEqual(await propagate('middleware only'), { priority: '-1' })
    })

    it('does not infer a server resource for app.request()', async () => {
      assert.deepStrictEqual(await propagate('app request'), { priority: '-1' })
    })
  })
}
