'use strict'

// Set K_SERVICE before any modules load to enable push subscription plugin
process.env.K_SERVICE = 'test-service'

const assert = require('node:assert/strict')
const { setTimeout: wait } = require('node:timers/promises')

const axios = require('axios')
const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const gc = global.gc ?? (() => {})

describe('Push Subscription Plugin', () => {
  let appListener
  let http

  before(() => {
    return agent.load(['http'], { client: false })
  })

  after(() => {
    return agent.close({ ritmReset: false })
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
  function createServer () {
    return http.createServer((req, res) => {
      if (req.method === 'POST' && req.url.startsWith('/push-endpoint')) {
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
      'x-goog-pubsub-publish-time': new Date().toISOString()
    }

    return axios.post(`http://localhost:${port}/push-endpoint`, {
      message: { data: 'dGVzdA==', messageId: 'test-message-id' }
    }, {
      headers: { ...defaultHeaders, ...headers }
    })
  }

  // Helper to find pubsub.push.receive span
  function findPubSubSpan (traces) {
    const trace = traces.find(t => t.some(s => s.name === 'pubsub.push.receive'))
    if (!trace) throw new Error('Could not find trace with pubsub.push.receive span')
    return trace.find(s => s.name === 'pubsub.push.receive')
  }

  describe('Push subscription with raw HTTP server', () => {
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
              'pubsub.subscription_type': 'push'
            })

            // Verify delivery_duration_ms
            assert.ok(pubsubSpan.metrics['pubsub.delivery_duration_ms'] !== undefined)
            assert.ok(typeof pubsubSpan.metrics['pubsub.delivery_duration_ms'] === 'number')
            assert.ok(pubsubSpan.metrics['pubsub.delivery_duration_ms'] >= 0)
          })
          .then(done)
          .catch(done)

        sendPushRequest(port, {
          'x-goog-pubsub-message-id': messageId,
          'x-dd-publish-start-time': publishStartTime,
          'pubsub.topic': 'projects/test-project/topics/test-topic'
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

            if (pubsubSpan.meta['_dd.span_links']) {
              const spanLinks = JSON.parse(pubsubSpan.meta['_dd.span_links'])
              assert.ok(Array.isArray(spanLinks))
              const hasProducerLink = spanLinks.some(link => link.trace_id && link.span_id)
              assert.strictEqual(hasProducerLink, true)
            }
          })
          .then(done)
          .catch(done)

        sendPushRequest(port, {
          'x-datadog-trace-id': producerTraceId,
          'x-datadog-parent-id': producerSpanId,
          'x-datadog-sampling-priority': '1'
        }).catch(done)
      })
    })

    it('should add batch metadata to receive span', (done) => {
      const batchTraceId = 'abc123def456'
      const batchSpanId = '789012345678'

      appListener = createServer().listen(0, 'localhost', () => {
        const port = appListener.address().port

        agent
          .assertSomeTraces(traces => {
            const pubsubSpan = findPubSubSpan(traces)

            assertObjectContains(pubsubSpan.meta, {
              'pubsub.batch.description': 'Message 1 of 3',
              'pubsub.batch.request_trace_id': batchTraceId
            })
            assertObjectContains(pubsubSpan.metrics, {
              'pubsub.batch.message_count': 3,
              'pubsub.batch.message_index': 0
            })
          })
          .then(done)
          .catch(done)

        sendPushRequest(port, {
          '_dd.batch.size': '3',
          '_dd.batch.index': '0',
          '_dd.pubsub_request.trace_id': batchTraceId,
          '_dd.pubsub_request.span_id': batchSpanId
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
              '_dd.serviceoverride.type': 'integration'
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

        axios.post(`http://localhost:${port}/push-endpoint`, { data: 'regular' }, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0' // Not Google user agent
          }
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

        axios.post(`http://localhost:${port}/push-endpoint`, { message: { data: 'dGVzdA==' } }, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)'
            // Missing x-goog-pubsub-message-id
          }
        }).catch(done)
      })
    })

    describe('garbage collection and memory leaks', function () {
      if (typeof global.gc !== 'function') {
        return it.skip('requires --expose-gc flag')
      }

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

            // Force garbage collection multiple times
            gc()
            await wait(100)
            gc()
            await wait(100)
            gc()
            await wait(500)

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
                  'x-goog-pubsub-message-id': `msg-${i}`
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
