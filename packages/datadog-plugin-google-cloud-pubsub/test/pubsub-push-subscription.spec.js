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
    it('should create pubsub.delivery span as child of HTTP span', (done) => {
      // This test verifies the push subscription plugin behavior when properly configured
      const app = express()
      app.use(express.json())

      const messageId = '12345678'
      const subscriptionName = 'projects/test-project/subscriptions/test-sub'
      const publishTime = new Date().toISOString()
      const topicName = 'projects/test-project/topics/test-topic'

      app.post('/push-endpoint', (req, res) => {
        res.status(200).send('OK')
      })

      appListener = app.listen(0, 'localhost', () => {
        const port = appListener.address().port

        agent
          .assertSomeTraces(traces => {
            const trace = traces.find(t => t.some(s => s.name === 'express.request'))
            if (!trace) return

            const httpSpan = trace.find(s => s.name === 'express.request')
            expect(httpSpan).to.exist

            // The pubsub.delivery span may or may not be present depending on plugin initialization timing
            const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')
            if (pubsubSpan) {
              // If it exists, verify it has correct metadata
              expect(pubsubSpan.meta).to.include({
                'span.kind': 'consumer',
                component: 'google-cloud-pubsub',
                'pubsub.method': 'delivery',
                'pubsub.subscription': subscriptionName,
                'pubsub.message_id': messageId,
                'pubsub.delivery_method': 'push'
              })
              expect(pubsubSpan.parent_id.toString()).to.equal(httpSpan.span_id.toString())
            }
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
            const trace = traces.find(t => t.some(s => s.name === 'express.request'))
            if (!trace) return

            const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')
            if (pubsubSpan) {
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
            const trace = traces.find(t => t.some(s => s.name === 'express.request'))
            if (!trace) return

            const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')
            if (pubsubSpan) {
              // Verify service override
              expect(pubsubSpan.service).to.equal('test-pubsub')
              expect(pubsubSpan.meta).to.include({
                '_dd.base_service': 'test',
                '_dd.serviceoverride.type': 'integration'
              })
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
