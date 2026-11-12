'use strict'

// Set K_SERVICE before any modules load to enable push subscription plugin
process.env.K_SERVICE = 'test-service'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { setTimeout: wait } = require('node:timers/promises')

const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

if (typeof global.gc !== 'function') {
  throw new Error('requires --expose-gc flag')
}

const gc = global.gc

describe('Push Subscription Plugin', () => {
  let appListener
  let http

  before(() => {
    return agent.load(['http'], { client: false })
  })

  after(() => {
    return agent.close()
  })

  beforeEach(() => {
    http = require('http')
  })

  afterEach(() => {
    if (appListener) {
      appListener.close()
      appListener = null
    }
  })

  // Helper to create a simple HTTP server that responds OK to /push-endpoint
  /** @param {(req: import('node:http').IncomingMessage) => void} [onRequest] */
  function createServer (onRequest) {
    return http.createServer((req, res) => {
      if (req.method === 'POST' && req.url.startsWith('/push-endpoint')) {
        onRequest?.(req)
        req.on('data', () => {})
        req.on('end', () => {
          res.writeHead(200)
          res.end('OK')
        })
      } else {
        res.writeHead(404)
        res.end()
      }
    })
  }

  // Helper to send a push subscription request
  async function sendPushRequest (port, headers = {}) {
    const defaultHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
      'x-goog-pubsub-message-id': 'test-message-id',
      'x-goog-pubsub-subscription-name': 'projects/test-project/subscriptions/test-sub',
      'x-goog-pubsub-publish-time': new Date().toISOString(),
    }

    return httpRequest.post(`http://localhost:${port}/push-endpoint`, {
      message: { data: 'dGVzdA==', messageId: 'test-message-id' },
    }, {
      headers: { ...defaultHeaders, ...headers },
    })
  }

  // Helper to find pubsub.push.receive span
  function findPubSubSpan (traces) {
    const trace = traces.find(t => t.some(s => s.name === 'pubsub.push.receive'))
    if (!trace) throw new Error('Could not find trace with pubsub.push.receive span')
    return trace.find(s => s.name === 'pubsub.push.receive')
  }

  describe('Push subscription with raw HTTP server', () => {
    for (const behavior of ['continue', 'restart', 'ignore']) {
      describe(`with extraction behavior ${behavior}`, () => {
        let previousBehavior

        before(async () => {
          previousBehavior = process.env.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT
          process.env.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = behavior.toUpperCase()
          await agent.close()
          await agent.load(['http'], { client: false })
        })

        after(async () => {
          if (previousBehavior === undefined) delete process.env.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT
          else process.env.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = previousBehavior
          await agent.close()
          await agent.load(['http'], { client: false })
        })

        it('preserves the message link when selecting the batch parent', async () => {
          const tracer = require('../../dd-trace')
          let carrier
          appListener = createServer(() => {
            carrier = {}
            tracer.inject(tracer.scope().active(), 'text_map', carrier)
          })
          appListener.listen(0, 'localhost')
          await once(appListener, 'listening')
          const expected = agent.assertSomeTraces(traces => {
            const span = findPubSubSpan(traces)
            assert.strictEqual(span.parent_id.toString(), behavior === 'continue' ? '44' : '0')
            if (behavior === 'continue') {
              assert.strictEqual(span.trace_id.toString(), '42')
              assert.strictEqual(span.meta['_dd.span_links'], undefined)
            } else {
              assert.notStrictEqual(span.trace_id.toString(), '42')
              if (behavior === 'restart') {
                const links = JSON.parse(span.meta['_dd.span_links'])
                assert.strictEqual(links.length, 1)
                assert.strictEqual(links[0].span_id, '000000000000002b')
                assert.strictEqual(links[0].trace_id, '0000000000000000000000000000002a')
                assert.strictEqual(links[0].attributes.reason, 'propagation_behavior_extract')
              } else {
                assert.strictEqual(span.meta['_dd.span_links'], undefined)
              }
            }
          })
          await Promise.all([sendPushRequest(appListener.address().port, {
            'x-datadog-trace-id': '42',
            'x-datadog-parent-id': '43',
            'x-datadog-sampling-priority': '2',
            'ot-baggage-user': 'alice',
            '_dd.pubsub_request.trace_id': '000000000000002a',
            '_dd.pubsub_request.span_id': '000000000000002c',
          }), expected])
          assert.strictEqual(carrier['ot-baggage-user'], behavior === 'ignore' ? undefined : 'alice')
        })
      })
    }

    for (const [upper, batchUpper] of [
      [undefined, undefined],
      ['6af1eb9300000000', '6af1eb9300000000'],
      ['6af1eb9300000000', '6af1eb9400000000'],
    ]) {
      it(`preserves the selected trace metadata for upper IDs ${upper} / ${batchUpper}`, async () => {
        const tracer = require('../../dd-trace')
        const tags = '_dd.p.dm=-0,_dd.p.llmobs_parent_id=44,_dd.p.llmobs_sd=0' +
          (upper ? `,_dd.p.tid=${upper}` : '')
        let carrier
        appListener = createServer(() => {
          carrier = {}
          tracer.inject(tracer.scope().active(), 'text_map', carrier)
        })
        appListener.listen(0, 'localhost')
        await once(appListener, 'listening')
        const sameTrace = upper === batchUpper
        const expected = agent.assertSomeTraces(traces => {
          const span = findPubSubSpan(traces)
          assert.strictEqual(span.parent_id.toString(), sameTrace ? '44' : '43')
          assert.strictEqual(span.trace_id.toString(), '42')
          if (sameTrace) {
            assert.strictEqual(span.meta['_dd.span_links'], undefined)
          } else {
            const links = JSON.parse(span.meta['_dd.span_links'])
            assert.strictEqual(links[0].trace_id, batchUpper + '000000000000002a')
          }
        })
        const headers = {
          'x-datadog-trace-id': '42',
          'x-datadog-parent-id': '43',
          'x-datadog-sampling-priority': '2',
          'x-datadog-tags': tags,
          'ot-baggage-user': 'alice',
          traceparent: `00-${upper ?? '0000000000000000'}000000000000002a-000000000000002b-01`,
          tracestate: 'vendor=value,dd=s:2;t.dm:-0',
          '_dd.pubsub_request.trace_id': '000000000000002a',
          '_dd.pubsub_request.span_id': '000000000000002c',
        }
        if (batchUpper) headers['_dd.pubsub_request.p.tid'] = batchUpper
        await Promise.all([sendPushRequest(appListener.address().port, headers), expected])

        assert.strictEqual(carrier['x-datadog-trace-id'], '42')
        assert.strictEqual(carrier['x-datadog-sampling-priority'], '2')
        assert.strictEqual(carrier['ot-baggage-user'], 'alice')
        assert.ok(carrier.tracestate.split(',').includes('vendor=value'))
        assert.deepStrictEqual(carrier['x-datadog-tags'].split(',').sort(), tags.split(',').sort())
        assert.strictEqual(carrier.traceparent.split('-')[1], (upper ?? '0000000000000000') + '000000000000002a')
      })
    }

    it('preserves terminated-context links when selecting the batch parent', async () => {
      appListener = createServer()
      appListener.listen(0, 'localhost')
      await once(appListener, 'listening')
      const expected = agent.assertSomeTraces(traces => {
        const span = findPubSubSpan(traces)
        assert.strictEqual(span.parent_id.toString(), '44')
        assert.strictEqual(span.trace_id.toString(), '42')
        const links = JSON.parse(span.meta['_dd.span_links'])
        assert.strictEqual(links.length, 1)
        assert.strictEqual(links[0].span_id, '0000000000000028')
        assert.strictEqual(links[0].trace_id, '00000000000000000000000000000029')
        assert.strictEqual(links[0].attributes.reason, 'terminated_context')
      })
      await Promise.all([sendPushRequest(appListener.address().port, {
        'x-datadog-trace-id': '42',
        'x-datadog-parent-id': '43',
        'x-datadog-sampling-priority': '2',
        traceparent: '00-00000000000000000000000000000029-0000000000000028-01',
        '_dd.pubsub_request.trace_id': '000000000000002a',
        '_dd.pubsub_request.span_id': '000000000000002c',
      }), expected])
    })

    it('should create pubsub.push.receive span with delivery duration', (done) => {
      const messageId = 'http-test-789'
      const publishStartTime = Date.now().toString()

      appListener = createServer().listen(0, 'localhost', () => {
        const port = appListener.address().port

        agent
          .assertSomeTraces(traces => {
            const pubsubSpan = findPubSubSpan(traces)

            assertObjectContains(pubsubSpan.meta, {
              'span.kind': 'consumer',
              component: 'google-cloud-pubsub',
              'pubsub.message_id': messageId,
              'pubsub.subscription_type': 'push',
            })

            // Verify delivery_duration_ms
            assert.notStrictEqual(pubsubSpan.metrics['pubsub.delivery_duration_ms'], undefined)
            assert.strictEqual(typeof pubsubSpan.metrics['pubsub.delivery_duration_ms'], 'number')
            assert.ok(
              pubsubSpan.metrics['pubsub.delivery_duration_ms'] >= 0,
              `Expected ${pubsubSpan.metrics['pubsub.delivery_duration_ms']} >= 0`
            )
          })
          .then(done)
          .catch(done)

        sendPushRequest(port, {
          'x-goog-pubsub-message-id': messageId,
          'x-dd-publish-start-time': publishStartTime,
          'pubsub.topic': 'projects/test-project/topics/test-topic',
        }).catch(done)
      })
    })

    it('should propagate distributed trace context from producer to push receive', (done) => {
      const producerTraceId = '1234567890abcdef'
      const producerSpanId = 'fedcba0987654321'

      appListener = createServer().listen(0, 'localhost', () => {
        const port = appListener.address().port

        agent
          .assertSomeTraces(traces => {
            const pubsubSpan = findPubSubSpan(traces)

            assert.strictEqual(pubsubSpan.meta['_dd.span_links'], undefined)
          })
          .then(done)
          .catch(done)

        sendPushRequest(port, {
          'x-datadog-trace-id': producerTraceId,
          'x-datadog-parent-id': producerSpanId,
          'x-datadog-sampling-priority': '1',
        }).catch(done)
      })
    })

    it('should add batch metadata to receive span', (done) => {
      const batchTraceId = 'abc123def4567890'
      const batchSpanId = '789012345678abcd'
      const batchTraceIdUpper = 'abcdef1234567890'

      appListener = createServer().listen(0, 'localhost', () => {
        const port = appListener.address().port

        agent
          .assertSomeTraces(traces => {
            const pubsubSpan = findPubSubSpan(traces)

            assertObjectContains(pubsubSpan.meta, {
              'pubsub.batch.description': 'Message 1 of 3',
              'pubsub.batch.request_trace_id': batchTraceId,
            })
            assertObjectContains(pubsubSpan.metrics, {
              'pubsub.batch.message_count': 3,
              'pubsub.batch.message_index': 0,
            })
            assert.deepStrictEqual(JSON.parse(pubsubSpan.meta['_dd.span_links']), [{
              trace_id: batchTraceIdUpper + batchTraceId,
              span_id: batchSpanId,
            }])
          })
          .then(done)
          .catch(done)

        sendPushRequest(port, {
          '_dd.batch.size': '3',
          '_dd.batch.index': '0',
          '_dd.pubsub_request.trace_id': batchTraceId,
          '_dd.pubsub_request.span_id': batchSpanId,
          '_dd.pubsub_request.p.tid': batchTraceIdUpper,
        }).catch(done)
      })
    })

    it('should set service name with -pubsub suffix', (done) => {
      appListener = createServer().listen(0, 'localhost', () => {
        const port = appListener.address().port

        agent
          .assertSomeTraces(traces => {
            const pubsubSpan = findPubSubSpan(traces)

            assert.strictEqual(pubsubSpan.service, 'test-pubsub')
            assertObjectContains(pubsubSpan.meta, {
              '_dd.base_service': 'test',
              '_dd.serviceoverride.type': 'integration',
            })
          })
          .then(done)
          .catch(done)

        sendPushRequest(port).catch(done)
      })
    })

    it('should NOT create pubsub span for non-push-subscription requests', (done) => {
      appListener = createServer().listen(0, 'localhost', () => {
        const port = appListener.address().port

        agent
          .assertSomeTraces(traces => {
            const trace = traces.find(t => t.some(s => s.name === 'web.request'))
            if (!trace) return

            const pubsubSpan = trace.find(s => s.name === 'pubsub.push.receive')
            assert.ok(!pubsubSpan, 'pubsub.push.receive span should NOT exist')
          })
          .then(done)
          .catch(done)

        httpRequest.post(`http://localhost:${port}/push-endpoint`, { data: 'regular' }, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0', // Not Google user agent
          },
        }).catch(done)
      })
    })

    it('should NOT create pubsub span when missing required headers', (done) => {
      appListener = createServer().listen(0, 'localhost', () => {
        const port = appListener.address().port

        agent
          .assertSomeTraces(traces => {
            const trace = traces.find(t => t.some(s => s.name === 'web.request'))
            if (!trace) return

            const pubsubSpan = trace.find(s => s.name === 'pubsub.push.receive')
            assert.ok(!pubsubSpan, 'pubsub.push.receive span should NOT exist')
          })
          .then(done)
          .catch(done)

        httpRequest.post(`http://localhost:${port}/push-endpoint`, { message: { data: 'dGVzdA==' } }, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
            // Missing x-goog-pubsub-message-id
          },
        }).catch(done)
      })
    })

    describe('garbage collection and memory leaks', function () {
      it('should clean up receiveSpans WeakMap when request is garbage collected', function (done) {
        this.timeout(10000)

        let requestWasCollected = false
        const finalizationRegistry = new FinalizationRegistry(() => {
          requestWasCollected = true
        })

        const server = http.createServer((req, res) => {
          if (req.method === 'POST') {
            finalizationRegistry.register(req, 'test-request')
            req.on('data', () => {})
            req.on('end', () => {
              res.writeHead(200)
              res.end('OK')
            })
          }
        })

        appListener = server.listen(0, 'localhost', async () => {
          const port = server.address().port

          try {
            await sendPushRequest(port)
            await wait(100)

            // FinalizationRegistry callbacks are scheduled as microtasks after GC and
            // V8 may need multiple passes to collect an object. Poll until collected
            // or the test timeout is reached to avoid flakiness from GC timing variance.
            const deadline = Date.now() + 8000
            while (Date.now() < deadline) {
              gc()
              await wait(100)
              if (requestWasCollected) break
            }

            assert.strictEqual(requestWasCollected, true)
            done()
          } catch (err) {
            done(err)
          }
        })
      })

      it('should not leak memory with many push requests', function (done) {
        this.timeout(15000)

        appListener = createServer().listen(0, 'localhost', async () => {
          const port = appListener.address().port

          try {
            const initialMemory = process.memoryUsage().heapUsed

            // Send 100 requests
            const promises = []
            for (let i = 0; i < 100; i++) {
              promises.push(
                sendPushRequest(port, {
                  'x-goog-pubsub-message-id': `msg-${i}`,
                }).catch(() => {})
              )
            }

            await Promise.all(promises)
            await wait(500)

            // Force GC
            gc()
            await wait(100)
            gc()

            const afterMemory = process.memoryUsage().heapUsed
            const memoryIncrease = afterMemory - initialMemory

            // Memory should not increase significantly (less than 10MB for 100 requests)
            assert.ok(
              memoryIncrease < (10 * 1024 * 1024),
              `Memory increase should be minimal but was ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB`
            )

            done()
          } catch (err) {
            done(err)
          }
        })
      })
    })
  })
})
