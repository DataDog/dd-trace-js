/* eslint-disable max-len */
'use strict'

const EventBridge = require('../src/services/eventbridge')
const tracer = require('../../dd-trace')
const { randomBytes } = require('crypto')

describe('EventBridge', () => {
  let span
  withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
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

    it('generates tags for an event', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: 'my.event',
        Name: 'my-rule-name'
      }
      expect(eventbridge.generateTags(params, 'putEvent', {})).to.deep.equal({
        'aws.eventbridge.source': 'my.event',
        'resource.name': 'putEvent my.event',
        rulename: 'my-rule-name'
      })
    })
    it('won\'t create tags for a malformed event', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        foo: 'bar'
      }
      expect(eventbridge.generateTags(params, 'putEvent', {})).to.deep.equal({})
    })

    it('injects trace context to Eventbridge putEvents', () => {
      const eventbridge = new EventBridge(tracer)
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
      eventbridge.requestInject(span.context(), request)

      expect(request.params).to.deep.equal({ Entries: [{ Detail: '{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampling-priority":"1"}}' }] })
    })

    it('skips injecting trace context to Eventbridge if message is full', () => {
      const eventbridge = new EventBridge(tracer)
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
      eventbridge.requestInject(span.context(), request)
      expect(request.params).to.deep.equal(request.params)
    })

    it('returns an empty object when params is null', () => {
      const eventbridge = new EventBridge(tracer)
      expect(eventbridge.generateTags(null, 'putEvent', {})).to.deep.equal({})
    })

    it('returns an empty object when params.source is an empty string', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: ''
      }
      expect(eventbridge.generateTags(params, 'putEvent', {})).to.deep.equal({})
    })

    it('sets rulename as an empty string when params.Name is null', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: 'my.event',
        Name: null
      }
      expect(eventbridge.generateTags(params, 'putEvent', {})).to.deep.equal({
        'aws.eventbridge.source': 'my.event',
        'resource.name': 'putEvent my.event',
        rulename: ''
      })
    })

    it('sets resource.name as params.source when operation is null', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: 'my.event',
        Name: 'my-rule-name'
      }
      expect(eventbridge.generateTags(params, null, {})).to.deep.equal({
        'aws.eventbridge.source': 'my.event',
        'resource.name': 'my.event',
        rulename: 'my-rule-name'
      })
    })
    it('handles null response gracefully', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: 'my.event',
        Name: 'my-rule-name'
      }
      expect(eventbridge.generateTags(params, 'putEvent', null)).to.deep.equal({
        'aws.eventbridge.source': 'my.event',
        'resource.name': 'putEvent my.event',
        rulename: 'my-rule-name'
      })
    })
  })
})
