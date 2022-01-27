/* eslint-disable max-len */
'use strict'

const Kinesis = require('../src/services/kinesis')
const plugin = require('../src')
const tracer = require('../../dd-trace')
const { randomBytes } = require('crypto')

describe('Kinesis', () => {
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

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      kinesis.requestInject(span.context(), request, tracer)

      expect(request.params).to.deep.equal({
        Data: '{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampling-priority":"1","x-datadog-tags":""}}'
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

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      kinesis.requestInject(span.context(), request, tracer)

      expect(request.params).to.deep.equal({
        Records: [
          {
            Data: '{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampling-priority":"1","x-datadog-tags":""}}'
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

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      kinesis.requestInject(span.context(), request, tracer)
      expect(request.params).to.deep.equal(request.params)
    })
  })
})
