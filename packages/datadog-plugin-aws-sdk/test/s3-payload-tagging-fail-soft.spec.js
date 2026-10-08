'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')

const { FakeAgent, spawnProcAndExpectExit, stopProc } = require('../../../integration-tests/helpers')

const fixture = path.join(__dirname, 'fixtures/s3-payload-tagging-fail-soft.js')

describe('S3 payload tagging fail-soft process boundary', function () {
  this.timeout(20000)
  let receiver
  let server
  let child
  let endpoint
  let received

  beforeEach(async () => {
    received = new Map()
    receiver = await new FakeAgent().start()
    server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        received.set((req.url ?? '').split('?')[0], Buffer.concat(chunks))
        res.writeHead(200, { etag: '"d41d8cd98f00b204e9800998ecf8427e"', 'x-amz-request-id': 'request-id' })
        res.end()
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    endpoint = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`
  })

  afterEach(async () => {
    await stopProc(child)
    child = undefined
    if (server?.listening) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    await receiver?.stop()
  })

  for (const sdk of ['v2', 'v3']) {
    for (const scenario of ['snapshot', 'request', 'response']) {
      for (const capture of ['disabled', 'enabled']) {
        it(`survives a hostile ${scenario} exception with ${sdk} and capture ${capture}`, async () => {
          let completed
          let stderr = ''
          const groups = receiver.collectGroups({
            expectedCount: 2,
            timeout: 10000,
            predicate: group => group.some(span => span.name === 'aws.request'),
            trigger () {
              completed = spawnProcAndExpectExit(fixture, {
                execArgv: [],
                env: {
                  ...process.env,
                  S3_PAYLOAD_SDK: sdk,
                  S3_PAYLOAD_SCENARIO: scenario,
                  S3_PAYLOAD_CAPTURE: capture,
                  S3_PAYLOAD_ENDPOINT: endpoint,
                  DD_TRACE_AGENT_PORT: String(receiver.port),
                  DD_TRACE_ENABLED: 'true',
                  DD_TRACE_AGENT_URL: `http://127.0.0.1:${receiver.port}`,
                  DD_REMOTE_CONFIGURATION_ENABLED: 'false',
                  DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
                  DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING: '',
                  DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING: '',
                },
                silent: true,
              }, undefined, chunk => { stderr += chunk }, 10000)
              child = completed.proc
              return completed
            },
          })
          const [traces] = await Promise.all([groups, completed])
          assert.ok(!stderr.includes('payload-secret'), 'diagnostics must not include payload contents')
          const spans = traces.flat().filter(span => span.name === 'aws.request')
          assert.strictEqual(spans.length, 2)
          for (const span of spans) {
            assert.strictEqual(span.resource, 'putObject s3-fail-soft')
            assert.strictEqual(span.error, 0)
            assert.strictEqual(span.meta['aws.response.request_id'], 'request-id')
          }
          const enabled = capture === 'enabled'
          const [first, next] = spans
          if (!enabled || scenario !== 'response') {
            assert.ok(!Object.keys(first.meta).some(key => key.startsWith('aws.request.body')))
          } else {
            assert.strictEqual(first.meta['aws.request.body.Key'], 'first')
          }
          if (enabled && scenario !== 'response') {
            assert.ok(first.meta['aws.response.body.ETag'])
          } else {
            assert.ok(!Object.keys(first.meta).some(key => key.startsWith('aws.response.body')))
          }
          if (enabled) {
            assert.strictEqual(next.meta['aws.request.body.Key'], 'next')
            assert.ok(next.meta['aws.response.body.ETag'])
          } else {
            assert.ok(!Object.keys(next.meta).some(key => key.startsWith('aws.request.body')))
            assert.ok(!Object.keys(next.meta).some(key => key.startsWith('aws.response.body')))
          }
          assert.deepStrictEqual(received.get('/s3-fail-soft/first'), Buffer.from('original bytes'))
          assert.deepStrictEqual(received.get('/s3-fail-soft/next'), Buffer.from('original bytes'))
        })
      }
    }
  }
})
