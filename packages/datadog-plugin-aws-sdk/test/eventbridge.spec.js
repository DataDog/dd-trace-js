/* eslint-disable max-len */
'use strict'

const Eventbridge = require('../src/services/eventbridge')
const plugin = require('../src')
const tracer = require('../../dd-trace').init()
const { randomBytes } = require('crypto')

describe('Eventbridge', () => {
  let span
  withVersions(plugin, 'aws-sdk', version => {
    let traceId
    let parentId
    let spanId
    before(() => {
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

    it('injects trace context to Eventbridge putEvents', () => {
      const eventbridge = new Eventbridge()
      const request = {
        params: {
          Entries: [
            {
              Detail: JSON.stringify({
                custom: 'data',
                for: 'my users',
                from: 'Aaron Stuyvenberg'
              })
            }
          ]
        },
        operation: 'putEvents'
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      eventbridge.requestInject(span.context(), request, tracer)

      expect(request.params).to.deep.equal({ 'Entries': [{ 'Detail': '{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampled":"1","x-datadog-sampling-priority":"1","x-datadog-tags":""}}' }] })
    })

    it('skips injecting trace context to Eventbridge if message is full', () => {
      const eventbridge = new Eventbridge()
      const request = {
        params: {
          Entries: [
            {
              Detail: JSON.stringify({ myGreatData: randomBytes(256000).toString('base64') })
            }
          ]
        },
        operation: 'putEvents'
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      eventbridge.requestInject(span.context(), request, tracer)
      expect(request.params).to.deep.equal(request.params)
    })
  })
})
