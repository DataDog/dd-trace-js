/* eslint-disable max-len */
'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const EventBridge = require('../src/services/eventbridge')
const plugin = require('../src')
const { randomBytes } = require('crypto')

describe('EventBridge', () => {
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

    it('generates tags for an event', () => {
      const eventbridge = new EventBridge()
      const params = {
        source: 'my.event'
      }
      expect(eventbridge.generateTags(params, 'putEvent', {})).to.deep.equal({
        'aws.eventbridge.source': 'my.event',
        'resource.name': 'putEvent my.event'
      })
    })
    it('won\'t create tags for a malformed event', () => {
      const eventbridge = new EventBridge()
      const params = {
        foo: 'bar'
      }
      expect(eventbridge.generateTags(params, 'putEvent', {})).to.deep.equal({})
    })

    it('injects trace context to Eventbridge putEvents', () => {
      const eventbridge = new EventBridge()
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

      traceId = span.context().toTraceId()
      spanId = span.context().toSpanId()
      eventbridge.requestInject(span.context(), request, tracer)

      expect(request.params).to.deep.equal({ 'Entries': [{ 'Detail': `{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{"x-datadog-trace-id":"${traceId}","x-datadog-parent-id":"${spanId}","x-datadog-sampling-priority":"1"}}` }] })
    })

    it('skips injecting trace context to Eventbridge if message is full', () => {
      const eventbridge = new EventBridge()
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
      eventbridge.requestInject(span.context(), request, tracer)
      expect(request.params).to.deep.equal(request.params)
    })
  })
})
