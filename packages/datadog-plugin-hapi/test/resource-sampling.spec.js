'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const semver = require('semver')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

const route = '/users/{id}'
const resource = 'GET ' + route
const notFoundResource = 'GET /{p*}'

describe('hapi resource sampling', () => {
  withVersions('hapi', ['hapi', '@hapi/hapi'], (version, module, resolvedVersion) => {
    const legacy = semver.lt(resolvedVersion, '17.0.0')
    let server
    let tracer

    async function load (sampledResource) {
      await agent.load(['hapi', 'http'], [{}, { client: false }], {
        sampleRate: 0,
        rateLimit: -1,
        samplingRules: [{ resource: sampledResource, sampleRate: 1 }],
      })
      tracer = require('../../dd-trace')
      const hapi = require(`../../../versions/${module}@${version}`).get()
      const options = { address: '127.0.0.1', port: 0 }
      if (legacy) {
        server = new hapi.Server()
        server.connection(options)
      } else {
        server = hapi.server(options)
      }
    }

    afterEach(async () => {
      if (server) {
        if (legacy) {
          await new Promise(resolve => server.stop(resolve))
        } else {
          await server.stop()
        }
      }
      await agent.close()
    })

    async function request (event, path, status = 200, afterStart = false) {
      const carrier = {}
      const extension = (request, h) => {
        tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
        if (event === 'onRequest') request.setUrl('/users/42')
        return legacy ? h.continue() : h.continue
      }
      if (!afterStart) server.ext(event, extension)
      server.route({
        method: 'GET',
        path: route,
        handler (request, h) {
          return legacy ? h('matched') : 'matched'
        },
      })

      if (legacy) {
        await new Promise((resolve, reject) => server.start(error => error ? reject(error) : resolve()))
      } else {
        await server.start()
      }
      if (afterStart) server.ext(event, extension)
      const url = 'http://127.0.0.1:' + server.listener.address().port + path
      await httpRequest.get(url, { validateStatus: code => code === status })
      return carrier['x-datadog-sampling-priority']
    }

    it('uses the native route before authentication', async () => {
      await load(resource)
      const [propagated] = await Promise.all([
        request('onPreAuth', '/users/42'),
        agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } }),
      ])
      assert.strictEqual(propagated, '2')
    })

    for (const responseRoute of [route, '/public/{id}']) {
      const changed = responseRoute !== route
      it(changed ? 'samples a route updated before a late response hook' : 'keeps the route in a late response hook',
        async () => {
          const resource = 'GET ' + responseRoute
          await load(resource)
          if (changed) {
            server.ext('onPreResponse', (request, h) => {
              request.route.path = responseRoute
              return legacy ? h.continue() : h.continue
            })
          }
          const [propagated] = await Promise.all([
            request('onPreResponse', '/users/42', 200, true),
            agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } }),
          ])
          assert.strictEqual(propagated, '2')
        })
    }

    it('falls back during onRequest before native routing', async () => {
      await load(resource)
      const [propagated] = await Promise.all([
        request('onRequest', '/original'),
        agent.assertUserRejectedTrace(resource),
      ])
      assert.strictEqual(propagated, '-1')
    })

    it('restores the selected OTel route at the response after a hook clears the tag', async () => {
      const previous = process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
      process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = 'true'
      try {
        await load(resource)
        server.ext('onPreHandler', (request, h) => {
          tracer.scope().active().setTag('http.route', request.app.routeOverride)
          return legacy ? h.continue() : h.continue
        })
        const [propagated] = await Promise.all([
          request('onPreResponse', '/users/42', 200, true),
          agent.assertFirstTraceSpan({
            resource,
            meta: { 'http.route': route },
            metrics: { _sampling_priority_v1: 2 },
          }),
        ])
        assert.strictEqual(propagated, '2')
      } finally {
        if (previous === undefined) delete process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
        else process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = previous
      }
    })

    it('uses the selected not-found route before the response', async () => {
      await load(notFoundResource)
      const [propagated] = await Promise.all([
        request('onPreResponse', '/missing', 404),
        agent.assertFirstTraceSpan({ resource: notFoundResource, metrics: { _sampling_priority_v1: 2 } }),
      ])
      assert.strictEqual(propagated, '2')
    })

    it('uses the not-found route when native lookup rejects an internal route', async () => {
      await load(notFoundResource)
      server.route({
        method: 'GET',
        path: '/internal/{id}',
        config: { isInternal: true },
        handler (request, h) {
          return legacy ? h('internal') : 'internal'
        },
      })

      const [propagated] = await Promise.all([
        request('onPreResponse', '/internal/42', 404),
        agent.assertFirstTraceSpan({ resource: notFoundResource, metrics: { _sampling_priority_v1: 2 } }),
      ])
      assert.strictEqual(propagated, '2')
    })

    it('continues to sample network requests after an injected request without an HTTP server span', async () => {
      await load(resource)
      let activeSpan
      server.route({
        method: 'GET',
        path: '/injected/{id}',
        handler (request, h) {
          activeSpan = tracer.scope().active()
          const body = { id: request.params.id }
          return legacy ? h(body) : body
        },
      })

      const response = await server.inject('/injected/42')
      assert.strictEqual(activeSpan, null)
      assert.strictEqual(response.statusCode, 200)
      assert.deepStrictEqual(response.result, { id: '42' })

      const [propagated] = await Promise.all([
        request('onPreAuth', '/users/42'),
        agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } }),
      ])
      assert.strictEqual(propagated, '2')
    })
  })
})
