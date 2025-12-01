'use strict'

const axios = require('axios')
const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const agent = require('../../dd-trace/test/plugins/agent')

describe('Push Subscription Plugin', () => {
  let tracer
  let express
  let appListener

  before(() => {
    return agent.load(['http', 'express', 'google-cloud-pubsub'], { client: false })
  })

  after(() => {
    return agent.close({ ritmReset: false })
  })

  beforeEach(() => {
    tracer = require('../../dd-trace')
    express = require('express')
  })

  afterEach(() => {
    if (appListener) {
      appListener.close()
      appListener = null
    }
  })

  describe('Push subscription HTTP request handling', () => {
    it('should create BOTH pubsub.delivery span AND HTTP span in same trace', (done) => {
      const app = express()
      app.use(express.json())

      const messageId = '12345678'
      const subscriptionName = 'projects/test-project/subscriptions/test-sub'
      const publishTime = new Date().toISOString()
      const topicName = 'projects/test-project/topics/test-topic'

      let handlerCalled = false
      let activeSpanInHandler = null

      app.post('/push-endpoint', (req, res) => {
        handlerCalled = true
        // Capture what span is active inside the handler
        activeSpanInHandler = tracer.scope().active()
        res.status(200).send('OK')
      })

      appListener = app.listen(0, 'localhost', () => {
        const port = appListener.address().port

        agent
          .assertSomeTraces(traces => {
            // Find trace with both spans
            const trace = traces.find(t =>
              t.some(s => s.name === 'express.request') &&
              t.some(s => s.name === 'pubsub.delivery')
            )
            if (!trace) return

            expect(handlerCalled).to.be.true

            // BOTH spans must exist
            const httpSpan = trace.find(s => s.name === 'express.request')
            const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')

            expect(httpSpan, 'HTTP span must exist').to.exist
            expect(pubsubSpan, 'pubsub.delivery span must exist').to.exist

            // Verify the active span in the handler was the pubsub.delivery span
            if (activeSpanInHandler) {
              expect(activeSpanInHandler.context()._name).to.equal('pubsub.delivery')
            }

            // Verify pubsub.delivery span is a CHILD of HTTP span
            expect(pubsubSpan.parent_id.toString()).to.equal(httpSpan.span_id.toString())

            // Verify they're in the same trace
            expect(pubsubSpan.trace_id.toString()).to.equal(httpSpan.trace_id.toString())

            // Verify pubsub.delivery span has correct metadata
            expect(pubsubSpan.meta).to.include({
              'span.kind': 'consumer',
              component: 'google-cloud-pubsub',
              'pubsub.method': 'delivery',
              'pubsub.subscription': subscriptionName,
              'pubsub.message_id': messageId,
              'pubsub.delivery_method': 'push'
            })

            // Verify HTTP span has correct metadata
            expect(httpSpan.meta).to.include({
              'span.kind': 'server',
              'http.method': 'POST'
            })
          })
          .then(done)
          .catch(done)

        const postData = {
          message: {
            data: Buffer.from('test message').toString('base64'),
            messageId
          }
        }

        axios.post(`http://localhost:${port}/push-endpoint`, postData, {
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

    it('should propagate distributed trace context from producer to push delivery', (done) => {
      const app = express()
      app.use(express.json())

      const messageId = 'distributed-trace-msg'
      const subscriptionName = 'projects/test-project/subscriptions/test-sub'
      // Simulate trace context from the original publisher
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

            // The pubsub.delivery span should be linked to the producer span via span links
            // Check for span links metadata
            if (pubsubSpan.meta['_dd.span_links']) {
              const spanLinks = JSON.parse(pubsubSpan.meta['_dd.span_links'])
              expect(spanLinks).to.be.an('array')
              // Verify it contains a link back to the producer
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
            // Inject distributed trace context from producer
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

            // Verify batch metadata is present
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

            // Verify service override
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
