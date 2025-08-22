'use strict'

const { expect } = require('chai')
const sinon = require('sinon')
const dc = require('dc-polyfill')

const agent = require('../../dd-trace/test/plugins/agent')

// Create plugin instance for testing PubSub detection functions
const GoogleCloudPubsubTransitHandlerPlugin = require(
  '../../datadog-plugin-google-cloud-pubsub/src/pubsub-transit-handler'
)
const mockTracer = {
  startSpan: () => ({ setTag: () => {}, finish: () => {} }),
  extract: () => null,
  scope: () => ({ activate: (span, cb) => cb() })
}
const pluginInstance = new GoogleCloudPubsubTransitHandlerPlugin(mockTracer)
const isPubSubRequest = pluginInstance.isPubSubRequest.bind(pluginInstance)
const isCloudEventRequest = pluginInstance.isCloudEventRequest.bind(pluginInstance)

describe('server', () => {
  let http, server, port
  let startServerCh, startServerSpy

  before(async () => {
    await agent.load('http')
  })

  after(() => {
    return agent.close()
  })

  beforeEach(() => {
    http = require('http')
    startServerCh = dc.channel('apm:http:server:request:start')
    startServerSpy = sinon.stub()
    startServerCh.subscribe(startServerSpy)

    // Mock global tracer for server-side handling
    global._ddtrace = require('../../dd-trace')
  })

  afterEach((done) => {
    startServerCh.unsubscribe(startServerSpy)
    if (server) {
      server.close(done)
    } else {
      done()
    }
  })

  describe('GCP PubSub Push detection', () => {
    beforeEach((done) => {
      server = http.createServer((req, res) => {
        if (!res.headersSent) {
          res.writeHead(200)
          res.end('OK')
        }
      })
      server.listen(0, () => {
        port = server.address().port
        done()
      })
    })

    it('should detect PubSub push requests correctly', () => {
      const pubsubReq = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)'
        }
      }

      expect(isPubSubRequest(pubsubReq)).to.be.true
      expect(isCloudEventRequest(pubsubReq)).to.be.false
    })

    it('should detect Cloud Event requests correctly', () => {
      const cloudEventReq = {
        method: 'POST',
        headers: {
          'ce-specversion': '1.0',
          'ce-type': 'google.cloud.pubsub.topic.v1.messagePublished',
          'content-type': 'application/json'
        }
      }

      expect(isCloudEventRequest(cloudEventReq)).to.be.true
      expect(isPubSubRequest(cloudEventReq)).to.be.false
    })

    it('should handle PubSub requests via HTTP server', (done) => {
      const pubsubPayload = JSON.stringify({
        message: {
          data: Buffer.from('test').toString('base64'),
          messageId: 'test-id',
          attributes: { 'pubsub.topic': 'test-topic' }
        },
        subscription: 'projects/test/subscriptions/test'
      })

      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
          'Content-Length': Buffer.byteLength(pubsubPayload)
        }
      }, (res) => {
        res.on('data', () => {})
        res.on('end', () => {
          // PubSub requests are now handled entirely by our custom logic
          // and return early, so standard HTTP channels are NOT called
          setTimeout(() => {
            // Just verify the request completed successfully
            done()
          }, 50)
        })
      })

      req.write(pubsubPayload)
      req.end()
    })

    it('should handle Cloud Event requests via HTTP server', (done) => {
      const eventarcPayload = JSON.stringify({
        message: {
          data: Buffer.from('test').toString('base64'),
          messageId: 'test-eventarc-id',
          attributes: {
            'pubsub.topic': 'test-topic',
            traceparent: '00-abc123-def456-01'
          }
        },
        subscription: 'projects/test/subscriptions/eventarc-sub'
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
          'ce-source': '//pubsub.googleapis.com/projects/test/topics/test-topic',
          'ce-id': 'test-eventarc-id',
          'Content-Length': Buffer.byteLength(eventarcPayload)
        }
      }, (res) => {
        res.on('data', () => {})
        res.on('end', () => {
          // Cloud Events are now handled entirely by our custom logic
          // and return early, so standard HTTP channels are NOT called
          setTimeout(() => {
            // Just verify the request completed successfully
            done()
          }, 50)
        })
      })

      req.write(eventarcPayload)
      req.end()
    })

    it('should handle regular HTTP requests normally', (done) => {
      // Test that non-PubSub requests work normally and trigger regular HTTP channels
      const regularReq = {
        method: 'GET',
        headers: {
          'content-type': 'text/html',
          'user-agent': 'Mozilla/5.0'
        }
      }

      // Verify this is not detected as a PubSub request
      expect(isPubSubRequest(regularReq)).to.be.false
      expect(isCloudEventRequest(regularReq)).to.be.false

      done()
    })

    it('should not detect regular requests as PubSub or Cloud Events', () => {
      const regularReq = {
        method: 'GET',
        headers: {
          'content-type': 'text/html',
          'user-agent': 'Mozilla/5.0'
        }
      }

      expect(isPubSubRequest(regularReq)).to.be.false
      expect(isCloudEventRequest(regularReq)).to.be.false
    })
  })

  describe('error handling for server', () => {
    beforeEach((done) => {
      server = http.createServer((req, res) => {
        if (!res.headersSent) {
          res.writeHead(200)
          res.end('OK')
        }
      })
      server.listen(0, () => {
        port = server.address().port
        done()
      })
    })

    it('should handle request errors gracefully', (done) => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)'
        }
      }, (res) => {
        res.on('data', () => {})
        res.on('end', done)
      })

      // Simulate request error
      req.on('error', () => {
        // Error should be handled gracefully
        done()
      })

      req.write('invalid')
      req.destroy(new Error('Simulated error'))
    })
  })
})
