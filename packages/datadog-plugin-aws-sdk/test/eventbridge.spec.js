'use strict'

const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')

const { before, describe, it } = require('mocha')
const sinon = require('sinon')

const EventBridge = require('../src/services/eventbridge')
const tracer = require('../../dd-trace')
const { withAwsSdkVersions } = require('./spec_helpers')

describe('EventBridge', () => {
  let span
  withAwsSdkVersions((version, moduleName) => {
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
              priority: 1,
            },
            _trace: {
              started: [],
              origin: '',
            },
            _traceFlags: {
              sampled: 1,
            },
            _baggageItems: {},
            'x-datadog-trace-id': traceId,
            'x-datadog-parent-id': parentId,
            'x-datadog-sampling-priority': '1',
            toTraceId: () => {
              return traceId
            },
            toSpanId: () => {
              return spanId
            },
          }
        },
        addTags: sinon.stub(),
        setTag: sinon.stub(),
      }
      tracer._tracer.startSpan = sinon.spy(() => {
        return span
      })
    })

    it('generates tags for an event', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: 'my.event',
        Name: 'my-rule-name',
      }
      assert.deepStrictEqual(eventbridge.generateTags(params, 'putEvent', {}), {
        'aws.eventbridge.source': 'my.event',
        'messaging.system': 'aws_eventbridge',
        'resource.name': 'putEvent my.event',
        rulename: 'my-rule-name',
      })
    })
    it('won\'t create tags for a malformed event', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        foo: 'bar',
      }
      assert.strictEqual(eventbridge.generateTags(params, 'putEvent', {}), undefined)
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
                from: 'Aaron Stuyvenberg',
              }),
            },
          ],
        },
        operation: 'putEvents',
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      eventbridge.requestInject(span.context(), request)

      assert.deepStrictEqual(request.params, {
        Entries: [{
          Detail: '{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{' +
            '"x-datadog-trace-id":"456853219676779160",' +
            '"x-datadog-parent-id":"456853219676779160",' +
            '"x-datadog-sampling-priority":"1"' +
          '}}',
        }],
      })
    })

    it('skips injecting trace context to Eventbridge if message is full', () => {
      const eventbridge = new EventBridge(tracer)
      const request = {
        params: {
          Entries: [
            {
              Detail: JSON.stringify({ myGreatData: randomBytes(256000).toString('base64') }),
            },
          ],
        },
        operation: 'putEvents',
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      eventbridge.requestInject(span.context(), request)
      assert.deepStrictEqual(request.params, request.params)
    })

    it('returns undefined when params is null', () => {
      const eventbridge = new EventBridge(tracer)
      assert.strictEqual(eventbridge.generateTags(null, 'putEvent', {}), undefined)
    })

    it('returns undefined when params.source is an empty string', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: '',
      }
      assert.strictEqual(eventbridge.generateTags(params, 'putEvent', {}), undefined)
    })

    it('sets rulename as an empty string when params.Name is null', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: 'my.event',
        Name: null,
      }
      assert.deepStrictEqual(eventbridge.generateTags(params, 'putEvent', {}), {
        'aws.eventbridge.source': 'my.event',
        'messaging.system': 'aws_eventbridge',
        'resource.name': 'putEvent my.event',
        rulename: '',
      })
    })

    it('sets resource.name as params.source when operation is null', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: 'my.event',
        Name: 'my-rule-name',
      }
      assert.deepStrictEqual(eventbridge.generateTags(params, null, {}), {
        'aws.eventbridge.source': 'my.event',
        'messaging.system': 'aws_eventbridge',
        'resource.name': 'my.event',
        rulename: 'my-rule-name',
      })
    })
    it('handles null response gracefully', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: 'my.event',
        Name: 'my-rule-name',
      }
      assert.deepStrictEqual(eventbridge.generateTags(params, 'putEvent', null), {
        'aws.eventbridge.source': 'my.event',
        'messaging.system': 'aws_eventbridge',
        'resource.name': 'putEvent my.event',
        rulename: 'my-rule-name',
      })
    })
  })
})
