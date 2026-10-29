'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')

const { FakeAgent, spawnProcAndExpectExit, stopProc } = require('../../../integration-tests/helpers')
const { withAwsSdkVersions } = require('./spec_helpers')

const fixture = path.join(__dirname, 'fixtures/s3-payload-tagging-lazy-loading.js')

const captures = ['disabled', 'request', 'response', 'both']
const intercepts = ['none', 'fail-first']

describe('S3 payload tagging lazy loading process boundary', function () {
  this.timeout(20000)
  let receiver
  let server
  let child
  let outDir
  let endpoint
  let received

  beforeEach(async () => {
    received = new Map()
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-lazy-loading-'))
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
    fs.rmSync(outDir, { recursive: true, force: true })
  })

  withAwsSdkVersions((version, moduleName) => {
    const sdk = moduleName === '@aws-sdk/smithy-client' ? 'v3' : 'v2'

    for (const capture of captures) {
      for (const intercept of intercepts) {
        it(`loads payload tagging lazily with ${sdk}, capture ${capture}, intercept ${intercept}`, async () => {
          const out = path.join(outDir, `result-${sdk}-${capture}-${intercept}.json`)
          let completed
          const groups = receiver.collectGroups({
            expectedCount: 2,
            timeout: 10000,
            predicate: group => group.some(span => span.name === 'aws.request'),
            trigger () {
              completed = spawnProcAndExpectExit(fixture, {
                execArgv: [],
                env: {
                  ...process.env,
                  S3_LAZY_SDK: sdk,
                  S3_LAZY_VERSION: version,
                  S3_LAZY_CAPTURE: capture,
                  S3_LAZY_INTERCEPT: intercept,
                  S3_LAZY_ENDPOINT: endpoint,
                  S3_LAZY_OUT: out,
                  DD_TRACE_AGENT_PORT: String(receiver.port),
                  DD_TRACE_ENABLED: 'true',
                  DD_TRACE_AGENT_URL: `http://127.0.0.1:${receiver.port}`,
                  DD_REMOTE_CONFIGURATION_ENABLED: 'false',
                  DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
                  DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING: '',
                  DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING: '',
                },
                silent: true,
              }, undefined, undefined, 10000)
              child = completed.proc
              return completed
            },
          })
          const [traces] = await Promise.all([groups, completed])
          const result = JSON.parse(fs.readFileSync(out, 'utf8'))

          // With capture enabled, the plugin preloads payload tagging when
          // its instance is constructed, which happens when the AWS SDK module
          // loads (during INIT, before any invocation). A failed preload
          // (fail-first) leaves the module unloaded until the first enabled
          // capture gate retries, and that retry succeeds.
          const preloaded = capture !== 'disabled' && intercept === 'none'
          assert.strictEqual(result.loadedAfterTracerInit, false)
          assert.strictEqual(result.loadedAfterPluginRequire, false)
          assert.strictEqual(result.loadedAfterClientCreation, preloaded)

          const spans = traces.flat().filter(span => span.name === 'aws.request')
          assert.strictEqual(spans.length, 2)
          spans.sort((a, b) => (a.start.toString() >= b.start.toString() ? 1 : -1))
          for (const span of spans) {
            assert.strictEqual(span.resource, 'putObject s3-lazy-loading')
            assert.strictEqual(span.error, 0)
            assert.strictEqual(span.meta['aws.response.request_id'], 'request-id')
          }
          assert.deepStrictEqual(received.get('/s3-lazy-loading/first'), Buffer.from('original bytes'))
          assert.deepStrictEqual(received.get('/s3-lazy-loading/next'), Buffer.from('original bytes'))

          const [first, next] = spans
          const requestTags = span => Object.keys(span.meta).some(key => key.startsWith('aws.request.body'))
          const responseTags = span => Object.keys(span.meta).some(key => key.startsWith('aws.response.body'))
          if (capture === 'disabled') {
            // No enabled gate ever runs, so nothing is imported or loaded.
            assert.strictEqual(result.importAttempts, 0)
            assert.strictEqual(result.importSuccesses, 0)
            assert.strictEqual(result.loadedAfterFirstOperation, false)
            assert.strictEqual(result.loadedAfterOperations, false)
            assert.ok(!requestTags(first) && !responseTags(first))
            assert.ok(!requestTags(next) && !responseTags(next))
            return
          }

          const expectedRequest = capture === 'request' || capture === 'both'
          const expectedResponse = capture === 'response' || capture === 'both'

          // One load attempt at construction, plus exactly one retry when the
          // preload failed. The retry happens in the first enabled capture
          // gate of the first operation, so that operation is fully tagged.
          assert.strictEqual(result.importAttempts, intercept === 'none' ? 1 : 2)
          assert.strictEqual(result.importSuccesses, 1)
          assert.strictEqual(result.loadedAfterFirstOperation, true)
          assert.strictEqual(result.loadedAfterOperations, true)
          if (expectedRequest) {
            assert.strictEqual(first.meta['aws.request.body.Key'], 'first')
            assert.strictEqual(next.meta['aws.request.body.Key'], 'next')
          } else {
            assert.ok(!requestTags(first))
            assert.ok(!requestTags(next))
          }
          if (expectedResponse) {
            assert.ok(responseTags(first))
            assert.ok(responseTags(next))
          } else {
            assert.ok(!responseTags(first))
            assert.ok(!responseTags(next))
          }
        })
      }
    }
  })
})
