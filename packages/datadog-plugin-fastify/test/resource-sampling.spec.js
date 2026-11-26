'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

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
      const fastify = require(`../../../versions/fastify@${version}`).get()
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
      await new Promise((resolve, reject) => {
        app.listen({ host: '127.0.0.1', port: 0 }, error => error ? reject(error) : resolve())
      })

      const [{ data }] = await Promise.all([
        httpRequest.get('http://127.0.0.1:' + app.server.address().port + '/items/42'),
        agent.assertFirstTraceSpan({ resource: 'GET /items/:id', metrics: { _sampling_priority_v1: 2 } }),
      ])
      assert.deepStrictEqual(data, { priority: '2' })
    })
  })
})
