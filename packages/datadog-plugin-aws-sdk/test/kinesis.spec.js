/* eslint-disable max-len */
'use strict'

const Kinesis = require('../src/services/kinesis')
const tracer = require('../../dd-trace')
const { randomBytes } = require('crypto')
const { expect } = require('chai')

describe('Kinesis', () => {
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

    it('injects trace context to Kinesis putRecord', () => {
      const kinesis = new Kinesis(tracer)
      const request = {
        params: {
          Data: JSON.stringify({
            custom: 'data',
            for: 'my users',
            from: 'Aaron Stuyvenberg'
          })
        },
        operation: 'putRecord'
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      kinesis.requestInject(span.context(), request)

      expect(request.params).to.deep.equal({
        Data: '{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampling-priority":"1"}}'
      })
    })

    it('handles already b64 encoded data', () => {
      const kinesis = new Kinesis(tracer)
      const request = {
        params: {
          Data: Buffer.from(JSON.stringify({
            custom: 'data',
            for: 'my users',
            from: 'Aaron Stuyvenberg'
          })).toString('base64')
        },
        operation: 'putRecord'
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      kinesis.requestInject(span.context(), request)

      expect(request.params).to.deep.equal({
        Data: '{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampling-priority":"1"}}'
      })
    })

    it('injects trace context to Kinesis putRecords', () => {
      const kinesis = new Kinesis(tracer)
      const request = {
        params: {
          Records: [
            {
              Data: JSON.stringify({
                custom: 'data',
                for: 'my users',
                from: 'Aaron Stuyvenberg'
              })
            }
          ]
        },
        operation: 'putRecords'
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      kinesis.requestInject(span.context(), request)

      expect(request.params).to.deep.equal({
        Records: [
          {
            Data: '{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampling-priority":"1"}}'
          }
        ]
      })
    })
    it('skips injecting trace context to Kinesis if message is full', () => {
      const kinesis = new Kinesis(tracer)
      const request = {
        params: {
          Records: [
            {
              Data: JSON.stringify({
                myData: randomBytes(1000000).toString('base64')
              })
            }
          ]
        },
        operation: 'putRecords'
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      kinesis.requestInject(span.context(), request)
      expect(request.params).to.deep.equal(request.params)
    })

    it('won\t crash with raw strings', () => {
      const kinesis = new Kinesis(tracer)
      const request = {
        params: {
          Data: Buffer.from('asldkfjasdljasdlfkj').toString('base64')
        },
        operation: 'putRecord'
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      kinesis.requestInject(span.context(), request)

      expect(request.params).to.deep.equal(request.params)
    })

    it('won\t crash with an empty request', () => {
      const kinesis = new Kinesis(tracer)
      const request = {
        params: {},
        operation: 'putRecord'
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      kinesis.requestInject(span.context(), request)

      expect(request.params).to.deep.equal(request.params)
    })

    it('generates tags for proper input', () => {
      const kinesis = new Kinesis(tracer)
      const params = {
        StreamName: 'my-great-stream'
      }

      expect(kinesis.generateTags(params, 'putRecord')).to.deep.equal({
        'aws.kinesis.stream_name': 'my-great-stream',
        'resource.name': 'putRecord my-great-stream'
      })
    })
  })
})
