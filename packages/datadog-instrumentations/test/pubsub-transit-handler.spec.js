'use strict'

const { expect } = require('chai')
const sinon = require('sinon')
const sinonChai = require('sinon-chai')

// Enable sinon-chai
require('chai').use(sinonChai)

describe('Google Cloud Pub/Sub Transit Handler Plugin', () => {
  let pluginInstance
  let mockTracer
  let mockReq

  beforeEach(() => {
    // Create comprehensive mock tracer
    mockTracer = {
      startSpan: sinon.spy(() => ({
        setTag: sinon.stub(),
        finish: sinon.stub(),
        finished: false,
        context: sinon.stub().returns({
          _traceId: '12345678901234567890123456789012',
          _spanId: '1234567890123456'
        })
      })),
      extract: sinon.stub().returns({
        _traceId: '12345678901234567890123456789012',
        _spanId: '1234567890123456'
      }),
      scope: sinon.stub().returns({
        activate: sinon.stub().callsArg(1)
      }),
      _service: 'test-service',
      _log: {
        warn: sinon.stub(),
        error: sinon.stub()
      }
    }

    // Create plugin instance
    const GoogleCloudPubsubTransitHandlerPlugin = require(
      '../../datadog-plugin-google-cloud-pubsub/src/pubsub-transit-handler'
    )
    pluginInstance = new GoogleCloudPubsubTransitHandlerPlugin(mockTracer)

    // Create mock request/response objects
    mockReq = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
        host: 'localhost:3000',
        'x-forwarded-proto': 'http'
      },
      url: '/pubsub/push',
      body: {
        message: {
          data: Buffer.from('test message').toString('base64'),
          messageId: 'test-message-id',
          attributes: {
            'x-dd-delivery-trace-id': '12345678901234567890123456789012',
            'x-dd-delivery-span-id': '1234567890123456',
            'x-dd-delivery-start-time': '1640995200000',
            'gcloud.project_id': 'test-project',
            'pubsub.topic': 'test-topic'
          }
        },
        subscription: 'projects/test-project/subscriptions/test-subscription'
      }
    }
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('Request Detection', () => {
    it('should detect PubSub push requests', () => {
      const result = pluginInstance.isPubSubRequest(mockReq)
      expect(result).to.be.true
    })

    it('should detect CloudEvent requests', () => {
      const cloudEventReq = {
        ...mockReq,
        headers: {
          ...mockReq.headers,
          'ce-specversion': '1.0'
        }
      }
      const result = pluginInstance.isCloudEventRequest(cloudEventReq)
      expect(result).to.be.true
    })

    it('should reject non-PubSub requests', () => {
      const regularReq = {
        ...mockReq,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0'
        }
      }
      const result = pluginInstance.isPubSubRequest(regularReq)
      expect(result).to.be.false
    })
  })

  describe('Message Parsing', () => {
    it('should parse PubSub message data correctly', () => {
      const messageData = pluginInstance.parseMessageData(mockReq.body, mockReq, false)
      expect(messageData).to.exist
      expect(messageData.message).to.deep.equal(mockReq.body.message)
      expect(messageData.subscription).to.equal('projects/test-project/subscriptions/test-subscription')
      expect(messageData.attrs).to.deep.equal(mockReq.body.message.attributes)
      expect(messageData.projectId).to.equal('test-project')
      expect(messageData.topicName).to.equal('test-topic')
    })

    it('should parse CloudEvent data correctly', () => {
      const cloudEventBody = {
        message: {
          data: Buffer.from('test message').toString('base64'),
          attributes: {
            'ce-source': '//pubsub.googleapis.com/projects/test-project/topics/test-topic',
            'ce-type': 'google.cloud.pubsub.topic.v1.messagePublished'
          }
        },
        subscription: 'projects/test-project/subscriptions/eventarc-sub'
      }
      const cloudEventReq = {
        ...mockReq,
        body: cloudEventBody,
        headers: {
          ...mockReq.headers,
          'ce-subscription': 'projects/test-project/subscriptions/eventarc-sub'
        }
      }

      const messageData = pluginInstance.parseCloudEventData(cloudEventBody, cloudEventReq)
      expect(messageData).to.exist
      expect(messageData.attrs['ce-source']).to.equal('//pubsub.googleapis.com/projects/test-project/topics/test-topic')
      expect(messageData.attrs['ce-type']).to.equal('google.cloud.pubsub.topic.v1.messagePublished')
    })

    it('should handle missing req.body gracefully', () => {
      const messageData = pluginInstance.parseMessageData(null, mockReq, false)
      expect(messageData).to.be.null
      expect(mockTracer._log.warn).to.have.been.calledWith(
        'req.body is not available. PubSub push requests require body parsing middleware (e.g., express.json())'
      )
    })

    it('should handle parsing errors gracefully', () => {
      const invalidBody = { invalid: 'structure' }
      const messageData = pluginInstance.parseMessageData(invalidBody, mockReq, false)
      // parsePubSubData doesn't throw for invalid structure, it returns partial data
      expect(messageData).to.exist
      expect(messageData.message).to.be.undefined
      expect(messageData.subscription).to.be.undefined
    })
  })

  describe('Tracing Context Extraction', () => {
    it('should extract context from message attributes first', () => {
      const messageData = {
        attrs: {
          'x-datadog-trace-id': '12345678901234567890123456789012',
          'x-datadog-parent-id': '1234567890123456'
        }
      }

      const parent = pluginInstance.extractTracingContext(messageData, mockReq)
      expect(parent).to.exist
      expect(mockTracer.extract).to.have.been.calledWith('text_map', messageData.attrs)
    })

    it('should fallback to headers when no message attributes', () => {
      // Reset the mock to return null for empty attrs
      mockTracer.extract.resetHistory()
      mockTracer.extract.onFirstCall().returns(null) // First call with empty attrs returns null
      // Second call with headers returns context
      mockTracer.extract.onSecondCall().returns({
        _traceId: '12345678901234567890123456789012',
        _spanId: '1234567890123456'
      })

      const messageData = { attrs: {} }
      const parent = pluginInstance.extractTracingContext(messageData, mockReq)
      expect(parent).to.exist
      expect(mockTracer.extract).to.have.been.calledTwice // Once for attrs, once for headers
    })
  })

  describe('Synthetic Delivery Span Creation', () => {
    it('should create delivery span with synthetic context', () => {
      const messageData = {
        attrs: {
          'x-dd-delivery-trace-id': '12345678901234567890123456789012',
          'x-dd-delivery-span-id': '1234567890123456',
          'x-dd-delivery-start-time': '1640995200000',
          'gcloud.project_id': 'test-project',
          'pubsub.topic': 'test-topic'
        },
        topicName: 'test-topic',
        projectId: 'test-project',
        subscription: 'projects/test-project/subscriptions/test-subscription'
      }

      const span = pluginInstance.createDeliverySpan(messageData, false)

      expect(span).to.exist
      expect(mockTracer.startSpan).to.have.been.calledWith('pubsub.delivery', {
        resource: 'test-topic → projects/test-project/subscriptions/test-subscription',
        type: 'pubsub',
        tags: {
          component: 'google-cloud-pubsub',
          'span.kind': 'internal',
          'span.type': 'pubsub',
          'gcloud.project_id': 'test-project',
          'pubsub.topic': 'test-topic',
          'pubsub.subscription': 'projects/test-project/subscriptions/test-subscription',
          'pubsub.delivery_method': 'push',
          'pubsub.operation': 'delivery'
        },
        startTime: 1640995200000
      })
    })

    it('should create CloudEvent delivery span with additional tags', () => {
      const messageData = {
        attrs: {
          'ce-source': '//pubsub.googleapis.com/projects/test-project/topics/test-topic',
          'ce-type': 'google.cloud.pubsub.topic.v1.messagePublished',
          'gcloud.project_id': 'test-project',
          'pubsub.topic': 'test-topic'
        },
        topicName: 'test-topic',
        projectId: 'test-project',
        subscription: 'projects/test-project/subscriptions/eventarc-sub'
      }

      const span = pluginInstance.createDeliverySpan(messageData, true)

      expect(span).to.exist
      expect(mockTracer.startSpan).to.have.been.calledWith('pubsub.delivery', sinon.match({
        tags: sinon.match({
          'cloudevents.source': '//pubsub.googleapis.com/projects/test-project/topics/test-topic',
          'cloudevents.type': 'google.cloud.pubsub.topic.v1.messagePublished',
          'eventarc.trigger': 'pubsub',
          'pubsub.delivery_method': 'eventarc'
        })
      }))
    })
  })

  describe('Plugin Initialization', () => {
    it('should have the expected plugin methods', () => {
      expect(pluginInstance.isPubSubRequest).to.be.a('function')
      expect(pluginInstance.isCloudEventRequest).to.be.a('function')
      expect(pluginInstance.processPubSubRequest).to.be.a('function')
      expect(pluginInstance.handleRequestIntercept).to.be.a('function')
      expect(pluginInstance.parseMessageData).to.be.a('function')
      expect(pluginInstance.extractTracingContext).to.be.a('function')
      expect(pluginInstance.createDeliverySpan).to.be.a('function')
    })

    it('should subscribe to HTTP intercept channel', () => {
      const { getSharedChannel } = require('../../datadog-instrumentations/src/shared-channels')
      const httpInterceptCh = getSharedChannel('apm:http:server:request:intercept')
      expect(httpInterceptCh).to.exist
      expect(httpInterceptCh.hasSubscribers).to.be.true
    })
  })
})
