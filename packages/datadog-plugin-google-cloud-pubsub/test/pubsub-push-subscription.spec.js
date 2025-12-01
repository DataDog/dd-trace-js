'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Push Subscription Plugin', () => {
  let tracer
  let http
  let express
  let server
  let port

  withVersions('express', 'express', expressVersion => {
    beforeEach(() => {
      return agent.load(['http', 'express', 'google-cloud-pubsub'], { client: false })
        .then(() => {
          tracer = require('../../dd-trace')
          http = require('http')
          express = require(`../../../versions/express@${expressVersion}`).get()
        })
    })

    afterEach(() => {
      if (server) {
        server.close()
        server = null
      }
      return agent.close({ ritmReset: false })
    })

    describe('Push subscription HTTP request handling', () => {
      it.skip('should create pubsub.delivery span and HTTP span', (done) => {
        // This test documents expected behavior for Google Cloud Pub/Sub push subscriptions
        // The push subscription plugin auto-loads via the instrumentation and creates
        // a pubsub.delivery span that becomes the parent of application code

        const app = express()
        const messageId = '12345678'
        const subscriptionName = 'projects/test-project/subscriptions/test-sub'
        const publishTime = new Date().toISOString()
        const topicName = 'projects/test-project/topics/test-topic'

        app.post('/push-endpoint', (req, res) => {
          // In production, the active span would be pubsub.delivery
          const activeSpan = tracer.scope().active()
          expect(activeSpan).to.exist
          expect(activeSpan.context()._name).to.equal('pubsub.delivery')
          res.status(200).send('OK')
        })

        server = app.listen(0, 'localhost', () => {
          port = server.address().port

          const postData = JSON.stringify({
            message: {
              data: Buffer.from('test message').toString('base64'),
              messageId
            }
          })

          const options = {
            hostname: 'localhost',
            port,
            path: '/push-endpoint',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
              'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
              'x-goog-pubsub-message-id': messageId,
              'x-goog-pubsub-subscription-name': subscriptionName,
              'x-goog-pubsub-publish-time': publishTime,
              'pubsub.topic': topicName
            }
          }

          const req = http.request(options, (res) => {
            res.on('data', () => {})
            res.on('end', () => {
              agent.assertSomeTraces(traces => {
                const trace = traces.find(t =>
                  t.some(s => s.name === 'express.request') &&
                  t.some(s => s.name === 'pubsub.delivery')
                )
                expect(trace).to.exist

                const httpSpan = trace.find(s => s.name === 'express.request')
                const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')

                // Verify both spans exist
                expect(httpSpan).to.exist
                expect(pubsubSpan).to.exist

                // Verify HTTP span metadata
                expect(httpSpan.meta).to.include({
                  'span.kind': 'server',
                  'http.method': 'POST'
                })

                // Verify pubsub.delivery span metadata
                expect(pubsubSpan.meta).to.include({
                  'span.kind': 'consumer',
                  component: 'google-cloud-pubsub',
                  'pubsub.method': 'delivery',
                  'pubsub.subscription': subscriptionName,
                  'pubsub.message_id': messageId,
                  'pubsub.delivery_method': 'push',
                  'pubsub.topic': topicName
                })

                // Verify pubsub.delivery span is child of HTTP span
                expect(pubsubSpan.parent_id.toString()).to.equal(httpSpan.span_id.toString())
              }).then(() => done()).catch(done)
            })
          })

          req.on('error', done)
          req.write(postData)
          req.end()
        })
      })

      it.skip('should add batch metadata to delivery span', (done) => {
        const app = express()
        const messageId = 'batch-msg-1'
        const subscriptionName = 'projects/test-project/subscriptions/test-sub'
        const batchTraceId = 'abc123def456'
        const batchSpanId = '789012345678'

        app.post('/push-endpoint', (req, res) => {
          res.status(200).send('OK')
        })

        server = app.listen(0, 'localhost', () => {
          port = server.address().port

          const options = {
            hostname: 'localhost',
            port,
            path: '/push-endpoint',
            method: 'POST',
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
          }

          const req = http.request(options, (res) => {
            res.on('data', () => {})
            res.on('end', () => {
              agent.assertSomeTraces(traces => {
                const trace = traces.find(t => t.some(s => s.name === 'pubsub.delivery'))
                expect(trace).to.exist

                const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')
                expect(pubsubSpan).to.exist

                // Verify batch metadata
                expect(pubsubSpan.meta).to.include({
                  'pubsub.batch.description': 'Message 1 of 3',
                  'pubsub.batch.request_trace_id': batchTraceId,
                  'pubsub.batch.request_span_id': batchSpanId
                })

                expect(pubsubSpan.metrics).to.include({
                  'pubsub.batch.message_count': 3,
                  'pubsub.batch.message_index': 0
                })
              }).then(() => done()).catch(done)
            })
          })

          req.write(JSON.stringify({ message: { data: 'dGVzdA==' } }))
          req.end()
        })
      })

      it.skip('should set service name with -pubsub suffix', (done) => {
        const app = express()
        const messageId = 'service-test-123'
        const subscriptionName = 'projects/test-project/subscriptions/test-sub'

        app.post('/push-endpoint', (req, res) => {
          res.status(200).send('OK')
        })

        server = app.listen(0, 'localhost', () => {
          port = server.address().port

          const options = {
            hostname: 'localhost',
            port,
            path: '/push-endpoint',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
              'x-goog-pubsub-message-id': messageId,
              'x-goog-pubsub-subscription-name': subscriptionName,
              'x-goog-pubsub-publish-time': new Date().toISOString()
            }
          }

          const req = http.request(options, (res) => {
            res.on('data', () => {})
            res.on('end', () => {
              agent.assertSomeTraces(traces => {
                const trace = traces.find(t => t.some(s => s.name === 'pubsub.delivery'))
                expect(trace).to.exist

                const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')
                expect(pubsubSpan).to.exist

                // Verify service override
                expect(pubsubSpan.service).to.equal('test-pubsub')
                expect(pubsubSpan.meta).to.include({
                  '_dd.base_service': 'test',
                  '_dd.serviceoverride.type': 'integration'
                })
              }).then(() => done()).catch(done)
            })
          })

          req.write(JSON.stringify({ message: { data: 'dGVzdA==' } }))
          req.end()
        })
      })

      it('should NOT create pubsub span for non-push-subscription requests', (done) => {
        const app = express()

        app.post('/regular-endpoint', (req, res) => {
          const activeSpan = tracer.scope().active()
          // Should be HTTP span, not pubsub span
          if (activeSpan) {
            expect(activeSpan.context()._name).to.not.equal('pubsub.delivery')
          }
          res.status(200).send('OK')
        })

        server = app.listen(0, 'localhost', () => {
          port = server.address().port

          const options = {
            hostname: 'localhost',
            port,
            path: '/regular-endpoint',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0' // Not Google User-Agent
            }
          }

          const req = http.request(options, (res) => {
            res.on('data', () => {})
            res.on('end', () => {
              agent.assertSomeTraces(traces => {
                const trace = traces.find(t => t.some(s => s.name === 'express.request'))
                expect(trace).to.exist

                const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')
                expect(pubsubSpan).to.not.exist
              }).then(() => done()).catch(done)
            })
          })

          req.write(JSON.stringify({ data: 'regular request' }))
          req.end()
        })
      })

      it('should NOT create pubsub span when missing required headers', (done) => {
        const app = express()

        app.post('/push-endpoint', (req, res) => {
          res.status(200).send('OK')
        })

        server = app.listen(0, 'localhost', () => {
          port = server.address().port

          const options = {
            hostname: 'localhost',
            port,
            path: '/push-endpoint',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)'
              // Missing x-goog-pubsub-message-id
            }
          }

          const req = http.request(options, (res) => {
            res.on('data', () => {})
            res.on('end', () => {
              agent.assertSomeTraces(traces => {
                const trace = traces.find(t => t.some(s => s.name === 'express.request'))
                expect(trace).to.exist

                const pubsubSpan = trace.find(s => s.name === 'pubsub.delivery')
                expect(pubsubSpan).to.not.exist
              }).then(() => done()).catch(done)
            })
          })

          req.write(JSON.stringify({ message: { data: 'dGVzdA==' } }))
          req.end()
        })
      })
    })
  })
})
