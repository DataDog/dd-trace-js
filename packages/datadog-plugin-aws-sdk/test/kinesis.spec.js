/* eslint-disable max-len */
'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const Kinesis = require('../src/services/kinesis')
const plugin = require('../src')
const { randomBytes } = require('crypto')
const { expect } = require('chai')

describe('Kinesis', () => {
  let tracer
  let span
  withVersions(plugin, 'aws-sdk', version => {
    let traceId
    let spanId

    beforeEach(() => agent.load('aws-sdk'))
    afterEach(() => agent.close())

    before(() => {
      tracer = require('../../dd-trace')
      span = tracer.startSpan()
      span.context()._sampling.priority = 1
    })

    it('injects trace context to Kinesis putRecord', () => {
      const kinesis = new Kinesis()
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

      traceId = span.context().toTraceId()
      spanId = span.context().toSpanId()
      kinesis.requestInject(span.context(), request, tracer)

      expect(request.params).to.deep.equal({
        Data: `{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{"x-datadog-trace-id":"${traceId}","x-datadog-parent-id":"${spanId}","x-datadog-sampling-priority":"1"}}`
      })
    })

    it('handles already b64 encoded data', () => {
      const kinesis = new Kinesis()
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

      traceId = span.context().toTraceId()
      spanId = span.context().toSpanId()
      kinesis.requestInject(span.context(), request, tracer)

      expect(request.params).to.deep.equal({
        Data: `{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{"x-datadog-trace-id":"${traceId}","x-datadog-parent-id":"${spanId}","x-datadog-sampling-priority":"1"}}`
      })
    })

    it('injects trace context to Kinesis putRecords', () => {
      const kinesis = new Kinesis()
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

      traceId = span.context().toTraceId()
      spanId = span.context().toSpanId()
      kinesis.requestInject(span.context(), request, tracer)

      expect(request.params).to.deep.equal({
        Records: [
          {
            Data: `{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{"x-datadog-trace-id":"${traceId}","x-datadog-parent-id":"${spanId}","x-datadog-sampling-priority":"1"}}`
          }
        ]
      })
    })
    it('skips injecting trace context to Kinesis if message is full', () => {
      const kinesis = new Kinesis()
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

      kinesis.requestInject(span.context(), request, tracer)
      expect(request.params).to.deep.equal(request.params)
    })

    it('won\t crash with raw strings', () => {
      const kinesis = new Kinesis()
      const request = {
        params: {
          Data: Buffer.from('asldkfjasdljasdlfkj').toString('base64')
        },
        operation: 'putRecord'
      }

      kinesis.requestInject(span.context(), request, tracer)

      expect(request.params).to.deep.equal(request.params)
    })

    it('won\t crash with an empty request', () => {
      const kinesis = new Kinesis()
      const request = {
        params: {},
        operation: 'putRecord'
      }

      kinesis.requestInject(span.context(), request, tracer)

      expect(request.params).to.deep.equal(request.params)
    })

    it('generates tags for proper input', () => {
      const kinesis = new Kinesis()
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
