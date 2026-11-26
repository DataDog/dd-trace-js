'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { after, afterEach, before, describe, it } = require('mocha')

const createConfig = require('../../dd-trace/src/config')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

const resource = 'GET /api/items/:id'

describe('Hono resource sampling', () => {
  before(() => agent.load(['hono', 'http'], [{ middleware: false }, { client: false }], {
    rateLimit: -1,
    sampleRate: 0,
    samplingRules: [
      { resource, sampleRate: 1 },
      { resource: 'GET', sampleRate: 1 },
    ],
  }))

  after(() => agent.close())

  withVersions('hono', 'hono', version => {
    let server

    afterEach(async () => {
      if (server) await new Promise(resolve => server.close(resolve))
    })

    /**
     * @param {'single handler' | 'composed handlers' | 'before handler' | 'middleware only'} mode
     */
    async function propagate (mode) {
      const tracer = require('../../dd-trace')
      const { Hono } = require(`../../../versions/hono@${version}`).get()
      const { serve } = require('../../../versions/@hono/node-server@1.15.0').get()
      const app = new Hono()
      const api = app.basePath('/api')

      function inject () {
        const carrier = {}
        tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
        return carrier['x-datadog-sampling-priority']
      }

      if (mode === 'middleware only') {
        api.use(context => context.json({ priority: inject() }))
      } else {
        if (mode !== 'single handler') {
          api.use('/items/:id', (context, next) => {
            if (mode === 'before handler') context.set('priority', inject())
            return next()
          })
        }
        api.get('/items/:id', context => context.json({ priority: context.get('priority') ?? inject() }))
      }

      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
      await once(server, 'listening')
      const { data } = await httpRequest.get(`http://127.0.0.1:${server.address().port}/api/items/42`)
      return data
    }

    for (const mode of ['single handler', 'composed handlers']) {
      it(`samples the matched route with ${mode}`, async () => {
        const [body] = await Promise.all([
          propagate(mode),
          agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } }),
        ])
        assert.deepStrictEqual(body, { priority: '2' })
      })
    }

    it('falls back when only middleware has been entered', async () => {
      const [body] = await Promise.all([
        propagate('before handler'),
        agent.assertUserRejectedTrace(resource),
      ])
      assert.deepStrictEqual(body, { priority: '-1' })
    })

    it('does not claim a route from middleware-only matches', async () => {
      const priority = createConfig().DD_TRACE_OTEL_SEMANTICS_ENABLED ? 2 : -1
      const [body] = await Promise.all([
        propagate('middleware only'),
        priority === 2
          ? agent.assertFirstTraceSpan({ resource: 'GET', metrics: { _sampling_priority_v1: 2 } })
          : agent.assertUserRejectedTrace('GET'),
      ])
      assert.deepStrictEqual(body, { priority: String(priority) })
    })
  })
})
