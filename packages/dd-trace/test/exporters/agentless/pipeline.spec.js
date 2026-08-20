'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { URL } = require('node:url')

const { after, before, describe, it } = require('mocha')

require('../../setup/core')

const agent = require('../../plugins/agent')
const id = require('../../../src/id')
const AgentlessWriter = require('../../../src/exporters/agentless/writer')

describe('AgentlessWriter data pipeline', () => {
  let server
  let intakeUrl
  let resolveRequest
  let request

  before(done => {
    server = http.createServer((incoming, response) => {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.on('end', () => {
        resolveRequest({
          headers: incoming.headers,
          path: incoming.url,
          payload: JSON.parse(Buffer.concat(chunks).toString()),
        })
        response.end()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      intakeUrl = new URL(`http://127.0.0.1:${port}`)
      done()
    })
  })

  after(async () => {
    await agent.close()
    await new Promise(resolve => server.close(resolve))
  })

  it('encodes v0.4 and exports agentless JSON through the pipeline', async () => {
    request = new Promise(resolve => { resolveRequest = resolve })
    const writer = new AgentlessWriter({
      url: intakeUrl,
      metadata: {
        env: 'test-env',
        hostname: 'test-host',
        runtimeID: 'test-runtime-id',
      },
    })

    writer.append([{
      duration: 1,
      error: 0,
      meta: {},
      metrics: {},
      name: 'operation',
      parent_id: id('0'),
      resource: 'resource',
      service: 'service',
      span_id: id('2'),
      start: 1,
      trace_id: id('1'),
    }])

    await new Promise(resolve => writer.flush(resolve))
    const received = await request

    assert.strictEqual(received.path, '/api/v2/spans')
    assert.strictEqual(received.headers['dd-api-key'], process.env.DD_API_KEY)
    assert.strictEqual(received.headers['content-type'], 'application/json')
    assert.strictEqual(received.payload.traces[0].spans[0].name, 'operation')
    assert.strictEqual(received.payload.traces[0].spans[0].resource, 'resource')
    assert.strictEqual(received.payload.traces[0].spans[0].service, 'service')
    assert.ok(received.payload.traces[0].spans[0].meta, JSON.stringify(received.payload.traces[0].spans[0]))
    assert.strictEqual(received.payload.traces[0].spans[0].meta['_dd.compute_stats'], '1')
    assert.strictEqual(received.payload.traces[0].spans[0].metrics._trace_root, 1)
  })

  it('does not trace the pipeline intake request', async () => {
    await agent.load('http', { server: false })
    const writer = new AgentlessWriter({ url: intakeUrl })
    const noIntakeTrace = agent.assertNoTraces(() => {
      assert.fail('the pipeline intake request must not create an HTTP client trace')
    }, { timeoutMs: 100 })

    request = new Promise(resolve => { resolveRequest = resolve })
    writer.append([{
      duration: 1,
      error: 0,
      meta: {},
      metrics: {},
      name: 'operation',
      parent_id: id('0'),
      resource: 'resource',
      service: 'service',
      span_id: id('2'),
      start: 1,
      trace_id: id('1'),
    }])

    await new Promise(resolve => writer.flush(resolve))
    await request
    await noIntakeTrace
  })
})
