'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { afterEach, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

describe('HTTP server resource sampling', () => {
  let server
  let tracer
  let web

  beforeEach(async () => {
    await agent.load('http', { client: false }, {
      sampleRate: 0,
      rateLimit: -1,
      samplingRules: [
        { resource: 'GET', sampleRate: 1 },
        { resource: 'GET /items/:id', sampleRate: 1 },
        { resource: 'GET /items', sampleRate: 1 },
        { resource: 'PATCH /renamed/:id', sampleRate: 1 },
      ],
    })
    tracer = require('../../dd-trace')
    web = require('../../dd-trace/src/plugins/util/web')
  })

  afterEach(async () => {
    if (server) await new Promise(resolve => server.close(resolve))
    await agent.close()
  })

  async function propagate (configureRequest, method = 'GET') {
    const http = require('node:http')
    server = http.createServer((req, res) => {
      configureRequest?.(req)
      const context = web.root(req).context()
      const resource = context.getTag('resource.name')
      const carrier = {}
      tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        priority: carrier['x-datadog-sampling-priority'],
        resourceUnchanged: context.getTag('resource.name') === resource,
      }))
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = 'http://127.0.0.1:' + server.address().port + '/items/42'
    const { data } = await httpRequest.request(url, { method })
    return data
  }

  it('uses the method as the resource for bare HTTP without changing the resource tag', async () => {
    const [propagated] = await Promise.all([
      propagate(),
      agent.assertFirstTraceSpan({ resource: 'GET', metrics: { _sampling_priority_v1: 2 } }),
    ])
    assert.deepStrictEqual(propagated, { priority: '2', resourceUnchanged: true })
  })

  it('matches a resolved template before client propagation without changing the resource tag', async () => {
    const [propagated] = await Promise.all([
      propagate(req => web.setRoute(req, '/items/:id')),
      agent.assertFirstTraceSpan({ resource: 'GET /items/:id', metrics: { _sampling_priority_v1: 2 } }),
    ])
    assert.deepStrictEqual(propagated, { priority: '2', resourceUnchanged: true })
  })

  it('falls back rather than matching a mount prefix or method-only rule before routing', async () => {
    const [propagated] = await Promise.all([
      propagate(req => web.enterRoute(req, '/items')),
      agent.assertUserRejectedTrace('GET /items'),
    ])
    assert.deepStrictEqual(propagated, { priority: '-1', resourceUnchanged: true })
  })

  it('matches the HTTP method used for the exported resource name', async () => {
    const createConfig = require('../../dd-trace/src/config')
    const { DD_TRACE_OTEL_SEMANTICS_ENABLED: otel } = createConfig()
    const [propagated] = await Promise.all([
      propagate(req => {
        web.setRoute(req, '/renamed/:id')
        req.method = otel ? 'GET' : 'PATCH'
      }, otel ? 'PATCH' : 'GET'),
      agent.assertFirstTraceSpan({ resource: 'PATCH /renamed/:id', metrics: { _sampling_priority_v1: 2 } }),
    ])
    assert.deepStrictEqual(propagated, { priority: '2', resourceUnchanged: true })
  })
})
