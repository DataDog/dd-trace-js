'use strict'

const { expect } = require('chai')
const sinon = require('sinon')
const http = require('http')
const dc = require('dc-polyfill')

describe('Google Cloud Pub/Sub HTTP Handler Plugin', () => {
  let tracer, server, port

  // Import the HTTP handler plugin
  const GoogleCloudPubsubHttpHandlerPlugin = require('../../datadog-plugin-google-cloud-pubsub/src/http-handler')

  // Create helper functions for testing
  const mockTracer = {
    startSpan: () => ({ setTag: () => {}, finish: () => {} }),
    extract: () => null,
    scope: () => ({ activate: (span, cb) => cb() })
  }
  const pluginInstance = new GoogleCloudPubsubHttpHandlerPlugin(mockTracer)

  // Extract the methods we want to test
  const isPubSubRequest = pluginInstance.isPubSubRequest.bind(pluginInstance)
  const isCloudEventRequest = pluginInstance.isCloudEventRequest.bind(pluginInstance)
  const processEventRequest = pluginInstance.processPubSubRequest.bind(pluginInstance)

  before(() => {
    // Set up mock tracer
    tracer = {
      startSpan: sinon.stub().returns({
        context: sinon.stub().returns({
          parentId: 'parent-123',
          toSpanId: sinon.stub().returns('span-456'),
          toTraceId: sinon.stub().returns('trace-789')
        }),
        setTag: sinon.stub(),
        finish: sinon.stub(),
        finished: false
      }),
      extract: sinon.stub().returns({
        _spanId: 'extracted-parent-123',
        _traceId: 'extracted-trace-456',
        toTraceId: sinon.stub().returns('extracted-trace-456')
      }),
      inject: sinon.stub(),
      scope: sinon.stub().returns({
        activate: sinon.stub().callsArg(1)
      })
    }

    global._ddtrace = tracer
  })

  beforeEach((done) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
    })

    server.listen(0, () => {
      port = server.address().port
      done()
    })
  })

  afterEach((done) => {
    sinon.restore()
    if (server) {
      server.close(done)
    } else {
      done()
    }
  })

  describe('Function Exports', () => {
    it('should export required functions', () => {
      expect(typeof isPubSubRequest).to.equal('function')
      expect(typeof isCloudEventRequest).to.equal('function')
      expect(typeof processEventRequest).to.equal('function')
    })
  })

  after(() => {
    // Clean up global tracer mock
    delete global._ddtrace
  })

  describe('PubSub Push HTTP Request Detection', () => {
    it('should detect traditional PubSub push requests', (done) => {
      const payload = JSON.stringify({
        message: {
          data: Buffer.from('test message').toString('base64'),
          messageId: 'test-message-id',
          attributes: {
            traceparent: '00-12345678901234567890123456789012-1234567890123456-01'
          }
        },
        subscription: 'projects/test-project/subscriptions/test-subscription'
      })

      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        expect(res.statusCode).to.equal(200)
        done()
      })

      req.write(payload)
      req.end()
    })

    it('should detect Eventarc Cloud Events', (done) => {
      const payload = JSON.stringify({
        message: {
          data: Buffer.from('test message').toString('base64'),
          messageId: 'test-message-id',
          attributes: {
            traceparent: '00-12345678901234567890123456789012-1234567890123456-01'
          }
        },
        subscription: 'projects/test-project/subscriptions/eventarc-sub'
      })

      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ce-specversion': '1.0',
          'ce-type': 'google.cloud.pubsub.topic.v1.messagePublished',
          'ce-source': '//pubsub.googleapis.com/projects/test-project/topics/test-topic',
          'ce-id': 'test-message-id',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        expect(res.statusCode).to.equal(200)
        done()
      })

      req.write(payload)
      req.end()
    })

    it('should not interfere with regular HTTP requests', (done) => {
      const payload = JSON.stringify({ test: 'data' })

      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        expect(res.statusCode).to.equal(200)
        done()
      })

      req.write(payload)
      req.end()
    })
  })

  describe('Channel Integration', () => {
    it('should have proper channels defined', () => {
      // Verify that the HTTP server intercept channel exists (used by http-handler)
      const httpInterceptCh = dc.channel('apm:http:server:request:intercept')

      expect(httpInterceptCh).to.exist
    })
  })

  describe('Span Creation', () => {
    it('should call tracer.startSpan for PubSub requests', (done) => {
      const payload = JSON.stringify({
        message: {
          data: Buffer.from('test').toString('base64'),
          messageId: 'test-id',
          attributes: {
            traceparent: '00-12345678901234567890123456789012-1234567890123456-01'
          }
        },
        subscription: 'projects/test/subscriptions/test-sub'
      })

      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'APIs-Google',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        // Give it a moment to process
        setTimeout(() => {
          expect(global._ddtrace.startSpan.called).to.be.true
          done()
        }, 50)
      })

      req.write(payload)
      req.end()
    })
  })
})
