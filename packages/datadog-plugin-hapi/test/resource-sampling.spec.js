'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

const resource = 'GET /users/{id}'
const notFoundResource = 'GET /{p*}'

describe('hapi resource sampling', () => {
  withVersions('hapi', ['hapi', '@hapi/hapi'], (version, module, resolvedVersion) => {
    const legacy = semver.lt(resolvedVersion, '17.0.0')
    let server
    let tracer

    beforeEach(async () => {
      await agent.load(['hapi', 'http'], [{}, { client: false }], {
        sampleRate: 0,
        rateLimit: -1,
        samplingRules: [
          { resource, sampleRate: 1 },
          { resource: notFoundResource, sampleRate: 1 },
        ],
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
    })

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

    async function request (event, path, status = 200) {
      const carrier = {}
      server.ext(event, (request, h) => {
        tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
        if (event === 'onRequest') request.setUrl('/users/42')
        return legacy ? h.continue() : h.continue
      })
      server.route({
        method: 'GET',
        path: '/users/{id}',
        handler (request, h) {
          return legacy ? h('matched') : 'matched'
        },
      })

      if (legacy) {
        await new Promise((resolve, reject) => server.start(error => error ? reject(error) : resolve()))
      } else {
        await server.start()
      }
      const url = 'http://127.0.0.1:' + server.listener.address().port + path
      await httpRequest.get(url, { validateStatus: code => code === status })
      return carrier['x-datadog-sampling-priority']
    }

    it('uses the native route before authentication', async () => {
      const [propagated] = await Promise.all([
        request('onPreAuth', '/users/42'),
        agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } }),
      ])
      assert.strictEqual(propagated, '2')
    })

    it('falls back during onRequest before native routing', async () => {
      const [propagated] = await Promise.all([
        request('onRequest', '/original'),
        agent.assertUserRejectedTrace(resource),
      ])
      assert.strictEqual(propagated, '-1')
    })

    it('uses the selected not-found route before the response', async () => {
      const [propagated] = await Promise.all([
        request('onPreResponse', '/missing', 404),
        agent.assertFirstTraceSpan({ resource: notFoundResource, metrics: { _sampling_priority_v1: 2 } }),
      ])
      assert.strictEqual(propagated, '2')
    })

    it('serves an injected request without an HTTP server span', async () => {
      server.route({
        method: 'GET',
        path: '/users/{id}',
        handler (request, h) {
          const body = { id: request.params.id }
          return legacy ? h(body) : body
        },
      })

      const response = await server.inject('/users/42')
      assert.strictEqual(response.statusCode, 200)
      assert.deepStrictEqual(response.result, { id: '42' })
    })
  })
})
