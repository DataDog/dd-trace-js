/* eslint-disable max-len */
'use strict'

const Sns = require('../src/services/sns')
const plugin = require('../src')
const tracer = require('../../dd-trace')

describe('Sns', () => {
  let span
  withVersions(plugin, 'aws-sdk', version => {
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
            'DataType': 'String',
            'StringValue': '{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampling-priority":"1","x-datadog-tags":""}'
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
                'DataType': 'String',
                'StringValue': '{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampling-priority":"1","x-datadog-tags":""}'
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
  })
})
