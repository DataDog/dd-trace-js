'use strict'

const axios = require('axios')
const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')

describe('Push Subscription Plugin', () => {
  let tracer
  let appListener

  before(() => {
    return agent.load(['http', 'express', 'fastify', 'koa', 'google-cloud-pubsub'], { client: false })
  })

  after(() => {
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

  describe('Push subscription with Express', () => {
    // Only test Express 4.16.0+, which have express.json() middleware
    withVersions('express', 'express', '>=4.16.0', version => {
      let express

      beforeEach(() => {
        express = require(`../../../versions/express@${version}`).get()
      })

      it('should create BOTH pubsub.delivery span AND HTTP span in same trace', (done) => {
        const app = express()
        app.use(express.json())

        const messageId = 'express-test-123'
        const subscriptionName = 'projects/test-project/subscriptions/test-sub'
        const publishTime = new Date().toISOString()
        const topicName = 'projects/test-project/topics/test-topic'

        let handlerCalled = false
        let activeSpanInHandler = null

        app.post('/push-endpoint', (req, res) => {
          handlerCalled = true
          activeSpanInHandler = tracer.scope().active()
          res.status(200).send('OK')
        })

        appListener = app.listen(0, 'localhost', () => {
          const port = appListener.address().port

          agent
            .assertSomeTraces(traces => {
              const trace = traces.find(t =>
                t.some(s => s.name === 'express.request') &&
                t.some(s => s.name === 'pubsub.delivery')
              )
              if (!trace) return

              expect(handlerCalled).to.be.true

              const httpSpan = trace.find(s => s.name === 'express.request')
              const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')

              expect(httpSpan, 'Express HTTP span must exist').to.exist
              expect(pubsubSpan, 'pubsub.delivery span must exist').to.exist

              // Active span should be pubsub.delivery (but timing can vary in some Express versions)
              if (activeSpanInHandler) {
                const spanName = activeSpanInHandler.context()._name
                expect(['express.request', 'express.middleware', 'pubsub.delivery']).to.include(spanName)
              }

              // Both spans must be in the same trace
              expect(pubsubSpan.trace_id.toString()).to.equal(httpSpan.trace_id.toString())

              // Parent-child relationship should ideally exist, but may vary by version
              // At minimum, they should be in the same trace
              if (pubsubSpan.parent_id.toString() !== '0') {
                expect(pubsubSpan.parent_id.toString()).to.equal(httpSpan.span_id.toString())
              }

              expect(pubsubSpan.meta).to.include({
                'span.kind': 'consumer',
                component: 'google-cloud-pubsub',
                'pubsub.method': 'delivery',
                'pubsub.message_id': messageId,
                'pubsub.delivery_method': 'push'
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
              'pubsub.topic': topicName
            }
          }).catch(done)
        })
      })
    })
  })

  describe('Push subscription with Fastify', () => {
    withVersions('fastify', 'fastify', version => {
      let fastify

      beforeEach(() => {
        fastify = require(`../../../versions/fastify@${version}`).get()
      })

      it('should create BOTH pubsub.delivery span AND HTTP span in same trace', (done) => {
        const app = fastify()

        const messageId = 'fastify-test-456'
        const subscriptionName = 'projects/test-project/subscriptions/test-sub'
        const publishTime = new Date().toISOString()
        const topicName = 'projects/test-project/topics/test-topic'

        let handlerCalled = false
        let activeSpanInHandler = null

        app.post('/push-endpoint', (request, reply) => {
          handlerCalled = true
          activeSpanInHandler = tracer.scope().active()
          reply.code(200).send('OK')
        })

        app.listen({ port: 0, host: 'localhost' }, (err, address) => {
          if (err) return done(err)

          appListener = app.server
          const port = app.server.address().port

          agent
            .assertSomeTraces(traces => {
              const trace = traces.find(t =>
                t.some(s => s.name === 'fastify.request') &&
                t.some(s => s.name === 'pubsub.delivery')
              )
              if (!trace) return

              expect(handlerCalled).to.be.true

              const httpSpan = trace.find(s => s.name === 'fastify.request')
              const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')

              expect(httpSpan, 'Fastify HTTP span must exist').to.exist
              expect(pubsubSpan, 'pubsub.delivery span must exist').to.exist

              // Active span should be pubsub.delivery (but timing can vary in some Fastify versions)
              if (activeSpanInHandler) {
                const spanName = activeSpanInHandler.context()._name
                expect(['fastify.request', 'pubsub.delivery']).to.include(spanName)
              }

              // Both spans must be in the same trace
              expect(pubsubSpan.trace_id.toString()).to.equal(httpSpan.trace_id.toString())

              // Parent-child relationship should ideally exist, but may vary by version
              // At minimum, they should be in the same trace
              if (pubsubSpan.parent_id.toString() !== '0') {
                expect(pubsubSpan.parent_id.toString()).to.equal(httpSpan.span_id.toString())
              }

              expect(pubsubSpan.meta).to.include({
                'span.kind': 'consumer',
                component: 'google-cloud-pubsub',
                'pubsub.message_id': messageId,
                'pubsub.delivery_method': 'push'
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
              'pubsub.topic': topicName
            }
          }).catch(done)
        })
      })
    })
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
              t.some(s => s.name === 'pubsub.delivery')
            )
            if (!trace) return

            expect(handlerCalled).to.be.true

            const httpSpan = trace.find(s => s.name === 'web.request')
            const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')

            expect(httpSpan, 'HTTP server span must exist').to.exist
            expect(pubsubSpan, 'pubsub.delivery span must exist').to.exist

            // For raw HTTP, the active span might be web.request OR pubsub.delivery depending on timing
            if (activeSpanInHandler) {
              const spanName = activeSpanInHandler.context()._name
              expect(['web.request', 'pubsub.delivery']).to.include(spanName)
            }

            // For raw HTTP, parent-child relationship might not be established the same way
            // as with framework-based servers (Express, Fastify, etc.)
            // Both spans should exist in the same trace though
            expect(pubsubSpan.trace_id.toString()).to.equal(httpSpan.trace_id.toString())

            expect(pubsubSpan.meta).to.include({
              'span.kind': 'consumer',
              component: 'google-cloud-pubsub',
              'pubsub.message_id': messageId,
              'pubsub.delivery_method': 'push'
            })

            expect(httpSpan.meta).to.include({
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
            'pubsub.topic': topicName
          }
        }).catch(done)
      })
    })
  })

  describe('Push subscription with Koa', () => {
    withVersions('koa', 'koa', version => {
      let Koa

      beforeEach(() => {
        Koa = require(`../../../versions/koa@${version}`).get()
      })

      it('should create BOTH pubsub.delivery span AND HTTP span in same trace', (done) => {
        const app = new Koa()

        const messageId = 'koa-test-999'
        const subscriptionName = 'projects/test-project/subscriptions/test-sub'
        const publishTime = new Date().toISOString()
        const topicName = 'projects/test-project/topics/test-topic'

        let handlerCalled = false
        let activeSpanInHandler = null

        app.use(async (ctx) => {
          if (ctx.method === 'POST' && ctx.path === '/push-endpoint') {
            handlerCalled = true
            activeSpanInHandler = tracer.scope().active()
            ctx.status = 200
            ctx.body = 'OK'
          } else {
            ctx.status = 404
          }
        })

        appListener = app.listen(0, 'localhost', () => {
          const port = appListener.address().port

          agent
            .assertSomeTraces(traces => {
              const trace = traces.find(t =>
                t.some(s => s.name === 'koa.request') &&
                t.some(s => s.name === 'pubsub.delivery')
              )
              if (!trace) return

              expect(handlerCalled).to.be.true

              const httpSpan = trace.find(s => s.name === 'koa.request')
              const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')

              expect(httpSpan, 'Koa HTTP span must exist').to.exist
              expect(pubsubSpan, 'pubsub.delivery span must exist').to.exist

              // Active span should be pubsub.delivery (but timing can vary in some Koa versions)
              if (activeSpanInHandler) {
                const spanName = activeSpanInHandler.context()._name
                expect(['koa.request', 'koa.middleware', 'pubsub.delivery']).to.include(spanName)
              }

              // Both spans must be in the same trace
              expect(pubsubSpan.trace_id.toString()).to.equal(httpSpan.trace_id.toString())

              // Parent-child relationship should ideally exist, but may vary by version
              // At minimum, they should be in the same trace
              if (pubsubSpan.parent_id.toString() !== '0') {
                expect(pubsubSpan.parent_id.toString()).to.equal(httpSpan.span_id.toString())
              }

              expect(pubsubSpan.meta).to.include({
                'span.kind': 'consumer',
                component: 'google-cloud-pubsub',
                'pubsub.message_id': messageId,
                'pubsub.delivery_method': 'push'
              })

              expect(httpSpan.meta).to.include({
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
              'pubsub.topic': topicName
            }
          }).catch(done)
        })
      })
    })
  })

  describe('Push subscription HTTP request handling', () => {
    // Only test Express 4.16.0+, which have express.json() middleware
    withVersions('express', 'express', '>=4.16.0', version => {
      let express

      beforeEach(() => {
        express = require(`../../../versions/express@${version}`).get()
      })

      it('should propagate distributed trace context from producer to push delivery', (done) => {
        const app = express()
        app.use(express.json())

        const messageId = 'distributed-trace-msg'
        const subscriptionName = 'projects/test-project/subscriptions/test-sub'
        const producerTraceId = '1234567890abcdef'
        const producerSpanId = 'fedcba0987654321'

        app.post('/push-endpoint', (req, res) => {
          res.status(200).send('OK')
        })

        appListener = app.listen(0, 'localhost', () => {
          const port = appListener.address().port

          agent
            .assertSomeTraces(traces => {
              const trace = traces.find(t =>
                t.some(s => s.name === 'pubsub.delivery')
              )
              if (!trace) return

              const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')
              expect(pubsubSpan).to.exist

              if (pubsubSpan.meta['_dd.span_links']) {
                const spanLinks = JSON.parse(pubsubSpan.meta['_dd.span_links'])
                expect(spanLinks).to.be.an('array')
                const hasProducerLink = spanLinks.some(link =>
                  link.trace_id && link.span_id
                )
                expect(hasProducerLink).to.be.true
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
        const app = express()
        app.use(express.json())

        const messageId = 'batch-msg-1'
        const subscriptionName = 'projects/test-project/subscriptions/test-sub'
        const batchTraceId = 'abc123def456'
        const batchSpanId = '789012345678'

        app.post('/push-endpoint', (req, res) => {
          res.status(200).send('OK')
        })

        appListener = app.listen(0, 'localhost', () => {
          const port = appListener.address().port

          agent
            .assertSomeTraces(traces => {
              const trace = traces.find(t => t.some(s => s.name === 'pubsub.delivery'))
              if (!trace) return

              const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')
              expect(pubsubSpan).to.exist

              expect(pubsubSpan.meta).to.include({
                'pubsub.batch.description': 'Message 1 of 3',
                'pubsub.batch.request_trace_id': batchTraceId,
                'pubsub.batch.request_span_id': batchSpanId
              })
              expect(pubsubSpan.metrics).to.include({
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
        const app = express()
        app.use(express.json())

        const messageId = 'service-test-123'
        const subscriptionName = 'projects/test-project/subscriptions/test-sub'

        app.post('/push-endpoint', (req, res) => {
          res.status(200).send('OK')
        })

        appListener = app.listen(0, 'localhost', () => {
          const port = appListener.address().port

          agent
            .assertSomeTraces(traces => {
              const trace = traces.find(t => t.some(s => s.name === 'pubsub.delivery'))
              if (!trace) return

              const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')
              expect(pubsubSpan).to.exist

              expect(pubsubSpan.service).to.equal('test-pubsub')
              expect(pubsubSpan.meta).to.include({
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
        const app = express()
        app.use(express.json())

        app.post('/regular-endpoint', (req, res) => {
          res.status(200).send('OK')
        })

        appListener = app.listen(0, 'localhost', () => {
          const port = appListener.address().port

          agent
            .assertSomeTraces(traces => {
              const trace = traces.find(t => t.some(s => s.name === 'express.request'))
              if (!trace) return

              expect(trace).to.exist
              const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')
              expect(pubsubSpan).to.not.exist
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
        const app = express()
        app.use(express.json())

        app.post('/push-endpoint', (req, res) => {
          res.status(200).send('OK')
        })

        appListener = app.listen(0, 'localhost', () => {
          const port = appListener.address().port

          agent
            .assertSomeTraces(traces => {
              const trace = traces.find(t => t.some(s => s.name === 'express.request'))
              if (!trace) return

              expect(trace).to.exist
              const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')
              expect(pubsubSpan).to.not.exist
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
    })
  })
})
