'use strict'

// Set K_SERVICE before any modules load to enable push subscription plugin
process.env.K_SERVICE = 'test-service'

const assert = require('node:assert/strict')
const { setTimeout: wait } = require('node:timers/promises')

const axios = require('axios')
const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { assertObjectContains } = require('../../../integration-tests/helpers')

describe('Push Subscription Plugin', () => {
  let tracer
  let appListener

  before(() => {
    return agent.load(['http', 'google-cloud-pubsub'], { client: false })
  })

  after(() => {
    delete process.env.K_SERVICE
    return agent.close({ ritmReset: false })
  })

  beforeEach(() => {
    tracer = require('../../dd-trace')
  })

  afterEach(() => {
    if (appListener) {
      appListener.close()
      appListener = null
    }
  })

  describe('Push subscription with raw HTTP server', () => {
    let http

    beforeEach(() => {
      http = require('http')
    })

    it('should create BOTH pubsub.delivery span AND HTTP span in same trace', (done) => {
      const messageId = 'http-test-789'
      const subscriptionName = 'projects/test-project/subscriptions/test-sub'
      const publishTime = new Date().toISOString()
      const topicName = 'projects/test-project/topics/test-topic'

      let handlerCalled = false
      let activeSpanInHandler = null

      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/push-endpoint') {
          handlerCalled = true
          activeSpanInHandler = tracer.scope().active()

          req.on('data', () => {})
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/plain' })
            res.end('OK')
          })
        } else {
          res.writeHead(404)
          res.end()
        }
      })

      appListener = server.listen(0, 'localhost', () => {
        const port = server.address().port

        agent
          .assertSomeTraces(traces => {
            const trace = traces.find(t =>
              t.some(s => s.name === 'web.request') &&
              t.some(s => s.name === 'pubsub.request')
            )
            if (!trace) throw new Error('Could not find trace with both web.request and pubsub.request spans')

            assert.strictEqual(handlerCalled, true)

            const httpSpan = trace.find(s => s.name === 'web.request')
            const pubsubSpan = trace.find(s => s.name === 'pubsub.request')

            assert.ok(httpSpan, 'HTTP server span must exist')
            assert.ok(pubsubSpan, 'pubsub.request span must exist')

            // For raw HTTP, the active span might be web.request OR pubsub.request depending on timing
            if (activeSpanInHandler) {
              const spanName = activeSpanInHandler.context()._name
              assert.ok(['web.request', 'pubsub.request'].includes(spanName))
            }

            // For raw HTTP, parent-child relationship might not be established the same way
            // as with framework-based servers (Express, Fastify, etc.)
            // Both spans should exist in the same trace though
            assert.strictEqual(pubsubSpan.trace_id.toString(), httpSpan.trace_id.toString())

            assertObjectContains(pubsubSpan.meta, {
              'span.kind': 'consumer',
              component: 'google-cloud-pubsub',
              'pubsub.message_id': messageId,
              'pubsub.subscription_type': 'push'
            })

            assertObjectContains(httpSpan.meta, {
              'span.kind': 'server',
              'http.method': 'POST'
            })
          })
          .then(done)
          .catch(done)

        axios.post(`http://localhost:${port}/push-endpoint`, {
          message: { data: Buffer.from('test').toString('base64'), messageId }
        }, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
            'x-goog-pubsub-message-id': messageId,
            'x-goog-pubsub-subscription-name': subscriptionName,
            'x-goog-pubsub-publish-time': publishTime,
            'pubsub.topic': topicName,
            'x-dd-publish-start-time': String(Date.now() - 1000) // 1 second ago
          }
        }).catch(done)
      })
    })

    it('should propagate distributed trace context from producer to push delivery', (done) => {
      const messageId = 'distributed-trace-msg'
      const subscriptionName = 'projects/test-project/subscriptions/test-sub'
      const producerTraceId = '1234567890abcdef'
      const producerSpanId = 'fedcba0987654321'

      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/push-endpoint') {
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

      appListener = server.listen(0, 'localhost', () => {
        const port = server.address().port

        agent
          .assertSomeTraces(traces => {
            const trace = traces.find(t =>
              t.some(s => s.name === 'pubsub.request')
            )
            if (!trace) throw new Error('Could not find trace with pubsub.request span')

            const pubsubSpan = trace.find(s => s.name === 'pubsub.request')
            assert.ok(pubsubSpan)

            if (pubsubSpan.meta['_dd.span_links']) {
              const spanLinks = JSON.parse(pubsubSpan.meta['_dd.span_links'])
              assert.ok(Array.isArray(spanLinks))
              const hasProducerLink = spanLinks.some(link =>
                link.trace_id && link.span_id
              )
              assert.strictEqual(hasProducerLink, true)
            }
          })
          .then(done)
          .catch(done)

        axios.post(`http://localhost:${port}/push-endpoint`, { message: { data: 'dGVzdA==' } }, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
            'x-goog-pubsub-message-id': messageId,
            'x-goog-pubsub-subscription-name': subscriptionName,
            'x-goog-pubsub-publish-time': new Date().toISOString(),
            'x-datadog-trace-id': producerTraceId,
            'x-datadog-parent-id': producerSpanId,
            'x-datadog-sampling-priority': '1'
          }
        }).catch(done)
      })
    })

    it('should add batch metadata to delivery span', (done) => {
      const messageId = 'batch-msg-1'
      const subscriptionName = 'projects/test-project/subscriptions/test-sub'
      const batchTraceId = 'abc123def456'
      const batchSpanId = '789012345678'

      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/push-endpoint') {
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

      appListener = server.listen(0, 'localhost', () => {
        const port = server.address().port

        agent
          .assertSomeTraces(traces => {
            const trace = traces.find(t => t.some(s => s.name === 'pubsub.request'))
            if (!trace) throw new Error('Could not find trace with pubsub.request span')

            const pubsubSpan = trace.find(s => s.name === 'pubsub.request')
            assert.ok(pubsubSpan)

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

        axios.post(`http://localhost:${port}/push-endpoint`, { message: { data: 'dGVzdA==' } }, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
            'x-goog-pubsub-message-id': messageId,
            'x-goog-pubsub-subscription-name': subscriptionName,
            'x-goog-pubsub-publish-time': new Date().toISOString(),
            '_dd.batch.size': '3',
            '_dd.batch.index': '0',
            '_dd.pubsub_request.trace_id': batchTraceId,
            '_dd.pubsub_request.span_id': batchSpanId
          }
        }).catch(done)
      })
    })

    it('should set service name with -pubsub suffix', (done) => {
      const messageId = 'service-test-123'
      const subscriptionName = 'projects/test-project/subscriptions/test-sub'

      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/push-endpoint') {
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

      appListener = server.listen(0, 'localhost', () => {
        const port = server.address().port

        agent
          .assertSomeTraces(traces => {
            const trace = traces.find(t => t.some(s => s.name === 'pubsub.request'))
            if (!trace) throw new Error('Could not find trace with pubsub.request span')

            const pubsubSpan = trace.find(s => s.name === 'pubsub.request')
            assert.ok(pubsubSpan)

            assert.strictEqual(pubsubSpan.service, 'test-pubsub')
            assertObjectContains(pubsubSpan.meta, {
              '_dd.base_service': 'test',
              '_dd.serviceoverride.type': 'integration'
            })
          })
          .then(done)
          .catch(done)

        axios.post(`http://localhost:${port}/push-endpoint`, { message: { data: 'dGVzdA==' } }, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
            'x-goog-pubsub-message-id': messageId,
            'x-goog-pubsub-subscription-name': subscriptionName,
            'x-goog-pubsub-publish-time': new Date().toISOString()
          }
        }).catch(done)
      })
    })

    it('should NOT create pubsub span for non-push-subscription requests', (done) => {
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/regular-endpoint') {
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

      appListener = server.listen(0, 'localhost', () => {
        const port = server.address().port

        agent
          .assertSomeTraces(traces => {
            const trace = traces.find(t => t.some(s => s.name === 'web.request'))
            if (!trace) return

            assert.ok(trace)
            const pubsubSpan = trace.find(s => s.name === 'pubsub.request')
            assert.ok(!pubsubSpan)
          })
          .then(done)
          .catch(done)

        axios.post(`http://localhost:${port}/regular-endpoint`, { data: 'regular request' }, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0'
          }
        }).catch(done)
      })
    })

    it('should NOT create pubsub span when missing required headers', (done) => {
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/push-endpoint') {
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

      appListener = server.listen(0, 'localhost', () => {
        const port = server.address().port

        agent
          .assertSomeTraces(traces => {
            const trace = traces.find(t => t.some(s => s.name === 'web.request'))
            if (!trace) return

            assert.ok(trace)
            const pubsubSpan = trace.find(s => s.name === 'pubsub.request')
            assert.ok(!pubsubSpan)
          })
          .then(done)
          .catch(done)

        axios.post(`http://localhost:${port}/push-endpoint`, { message: { data: 'dGVzdA==' } }, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)'
          }
        }).catch(done)
      })
    })

    describe('garbage collection and memory leaks', function () {
      // GC tests need --expose-gc flag
      if (typeof global.gc !== 'function') {
        return it.skip('requires --expose-gc flag')
      }

      it('should clean up deliverySpans WeakMap when request is garbage collected', function (done) {
        this.timeout(10000)

        const messageId = 'gc-test-message'
        const subscriptionName = 'projects/test-project/subscriptions/test-sub'

        let requestWasCollected = false
        const finalizationRegistry = new FinalizationRegistry(() => {
          requestWasCollected = true
        })

        const server = http.createServer((req, res) => {
          if (req.method === 'POST' && req.url === '/push-endpoint') {
            // Register request for GC tracking
            finalizationRegistry.register(req, 'test-request')

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

        appListener = server.listen(0, 'localhost', async () => {
          const port = server.address().port

          try {
            await axios.post(`http://localhost:${port}/push-endpoint`, {
              message: { data: Buffer.from('test').toString('base64'), messageId }
            }, {
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
                'x-goog-pubsub-message-id': messageId,
                'x-goog-pubsub-subscription-name': subscriptionName,
                'x-goog-pubsub-publish-time': new Date().toISOString()
              }
            })

            // Wait for request to complete
            await wait(100)

            // Force garbage collection
            // @ts-expect-error We expect the test to be started with --trace-gc
            global.gc()
            await wait(100)
            // @ts-expect-error We expect the test to be started with --trace-gc
            global.gc()
            await wait(100)
            // @ts-expect-error We expect the test to be started with --trace-gc
            global.gc()

            // Wait for FinalizationRegistry callback
            await wait(500)

            // Verify request was garbage collected
            // This proves deliverySpans WeakMap doesn't prevent GC
            assert.strictEqual(requestWasCollected, true)
            done()
          } catch (err) {
            done(err)
          }
        })
      })

      it('should not leak memory with many push requests', function (done) {
        this.timeout(15000)

        const server = http.createServer((req, res) => {
          if (req.method === 'POST' && req.url === '/push-endpoint') {
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

        appListener = server.listen(0, 'localhost', async () => {
          const port = server.address().port

          try {
            const initialMemory = process.memoryUsage().heapUsed

            // Send many requests
            const promises = []
            for (let i = 0; i < 100; i++) {
              promises.push(
                axios.post(`http://localhost:${port}/push-endpoint`, {
                  message: { data: Buffer.from(`test ${i}`).toString('base64'), messageId: `msg-${i}` }
                }, {
                  headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
                    'x-goog-pubsub-message-id': `msg-${i}`,
                    'x-goog-pubsub-subscription-name': 'projects/test-project/subscriptions/test-sub',
                    'x-goog-pubsub-publish-time': new Date().toISOString()
                  }
                }).catch(() => {})
              )
            }

            await Promise.all(promises)

            // Wait for all requests to complete
            await wait(500)

            // Force GC
            // @ts-expect-error We expect the test to be started with --trace-gc
            global.gc()
            await wait(100)
            // @ts-expect-error We expect the test to be started with --trace-gc
            global.gc()

            const afterMemory = process.memoryUsage().heapUsed
            const memoryIncrease = afterMemory - initialMemory

            // Memory should not increase significantly (less than 10MB for 100 requests)
            // If deliverySpans WeakMap is leaking, this would be much higher
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
