'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { URL } = require('node:url')
const zlib = require('node:zlib')

const { after, before, describe, it } = require('mocha')

const { NODE_MAJOR, NODE_MINOR } = require('../../../../../version')
require('../../setup/core')

const agent = require('../../plugins/agent')
const id = require('../../../src/id')
const AgentlessWriter = require('../../../src/exporters/agentless/writer')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const zstdSupported = NODE_MAJOR >= 24 ||
  (NODE_MAJOR === 23 && NODE_MINOR >= 8) ||
  (NODE_MAJOR === 22 && NODE_MINOR >= 15)
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const zstdDecompressSync = zstdSupported ? zlib.zstdDecompressSync : undefined

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
          payload: Buffer.concat(chunks),
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
    assert.strictEqual(received.headers['content-encoding'], 'zstd')
    assert.deepStrictEqual(received.payload.subarray(0, ZSTD_MAGIC.length), ZSTD_MAGIC)

    if (zstdDecompressSync) {
      const payload = JSON.parse(zstdDecompressSync(received.payload).toString())
      const span = payload.traces[0].spans[0]

      assert.strictEqual(span.name, 'operation')
      assert.strictEqual(span.resource, 'resource')
      assert.strictEqual(span.service, 'service')
      assert.ok(span.meta, JSON.stringify(span))
      assert.strictEqual(span.meta['_dd.compute_stats'], '1')
      assert.strictEqual(span.metrics._trace_root, 1)
    }
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
