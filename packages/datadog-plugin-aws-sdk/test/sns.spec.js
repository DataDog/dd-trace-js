/* eslint-disable max-len */
'use strict'

const Sns = require('../src/services/sns')
const tracer = require('../../dd-trace')

describe('Sns', () => {
  let span
  withVersions('aws-sdk', 'aws-sdk', version => {
    let traceId
    let parentId
    let spanId
    before(() => {
      tracer.init()
      span = {
        finish: sinon.spy(() => {}),
        context: () => {
          return {
            _sampling: {
              priority: 1
            },
            _trace: {
              started: [],
              origin: ''
            },
            _traceFlags: {
              sampled: 1
            },
            'x-datadog-trace-id': traceId,
            'x-datadog-parent-id': parentId,
            'x-datadog-sampling-priority': '1',
            toTraceId: () => {
              return traceId
            },
            toSpanId: () => {
              return spanId
            }
          }
        },
        addTags: sinon.stub(),
        setTag: sinon.stub()
      }
      tracer._tracer.startSpan = sinon.spy(() => {
        return span
      })
    })

    it('injects trace context to SNS publish', () => {
      const sns = new Sns()
      const request = {
        params: {
          Message: 'Here is my sns message',
          TopicArn: 'some ARN'
        },
        operation: 'publish'
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      sns.requestInject(span.context(), request, tracer)

      expect(request.params).to.deep.equal({
        Message: 'Here is my sns message',
        MessageAttributes: {
          '_datadog': {
            'DataType': 'Binary',
            'BinaryValue': '{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampling-priority":"1"}'
          }
        },
        'TopicArn': 'some ARN'
      })
    })

    it('injects trace context to SNS publishBatch', () => {
      const sns = new Sns()
      const request = {
        params: {
          PublishBatchRequestEntries: [
            { Message: 'Here is my SNS message' },
            { Message: 'Here is another SNS Message' }
          ],
          TopicArn: 'some ARN'
        },
        operation: 'publishBatch'
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      sns.requestInject(span.context(), request, tracer)

      expect(request.params).to.deep.equal({
        PublishBatchRequestEntries: [
          {
            Message: 'Here is my SNS message',
            MessageAttributes: {
              '_datadog': {
                'DataType': 'Binary',
                'BinaryValue': '{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampling-priority":"1"}'
              }
            }
          },
          {
            Message: 'Here is another SNS Message'
          }
        ],
        'TopicArn': 'some ARN'
      })
    })
    it('skips injecting trace context to SNS if message attributes are full', () => {
      const sns = new Sns()
      const request = {
        params: {
          Message: 'Here is my sns message',
          TopicArn: 'some ARN',
          MessageAttributes: {
            keyOne: {},
            keyTwo: {},
            keyThree: {},
            keyFour: {},
            keyFive: {},
            keySix: {},
            keySeven: {},
            keyEight: {},
            keyNine: {},
            keyTen: {}
          }
        },
        operation: 'publish'
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      sns.requestInject(span.context(), request, tracer)
      expect(request.params).to.deep.equal(request.params)
    })

    it('generates tags for proper publish calls', () => {
      const sns = new Sns()
      const params = {
        TopicArn: 'my-great-topic'
      }
      expect(sns.generateTags(params, 'publish', {})).to.deep.equal({
        'aws.sns.topic_arn': 'my-great-topic',
        'resource.name': 'publish my-great-topic'
      })
    })

    it('generates tags for proper responses', () => {
      const sns = new Sns()
      const params = {}
      const response = {
        data: {
          TopicArn: 'my-great-topic'
        }
      }
      expect(sns.generateTags(params, 'publish', response)).to.deep.equal({
        'aws.sns.topic_arn': 'my-great-topic',
        'resource.name': 'publish my-great-topic'
      })
    })

    it('returns empty tags for improper responses', () => {
      const sns = new Sns()
      const params = {}
      const response = {}
      expect(sns.generateTags(params, 'publish', response)).to.deep.equal({})
    })

    it('returns empty tags for empty requests', () => {
      const sns = new Sns()
      const response = {}
      expect(sns.generateTags(null, 'publish', response)).to.deep.equal({})
    })
  })
})
