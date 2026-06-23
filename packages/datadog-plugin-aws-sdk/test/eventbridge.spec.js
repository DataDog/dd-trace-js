'use strict'

const assert = require('node:assert/strict')

const { before, describe, it } = require('mocha')
const sinon = require('sinon')

const EventBridge = require('../src/services/eventbridge')
const tracer = require('../../dd-trace')
const { withAwsSdkVersions } = require('./spec_helpers')

const EVENTBRIDGE_EVENT_MAX_BYTES = 1024 * 1024
const TEST_TRACE_ID = '456853219676779160'
const TEST_SPAN_ID = '456853219676779160'
const TEST_PARENT_ID = '0000000000000000'
const TEST_DATADOG_CONTEXT = {
  'x-datadog-trace-id': TEST_TRACE_ID,
  'x-datadog-parent-id': TEST_SPAN_ID,
  'x-datadog-sampling-priority': '1',
}
const EVENTBRIDGE_CONTEXT_BYTES = Buffer.byteLength(`,"_datadog":${JSON.stringify(TEST_DATADOG_CONTEXT)}`)

/**
 * @param {number} size
 * @returns {string}
 */
function makeEventDetail (size) {
  const prefix = '{"myGreatData":"'
  const suffix = '"}'
  return `${prefix}${'a'.repeat(size - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`
}

/**
 * @param {number} size
 * @returns {string}
 */
function makeEventDetailForInjectedSize (size) {
  return makeEventDetail(size - EVENTBRIDGE_CONTEXT_BYTES)
}

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

      traceId = TEST_TRACE_ID
      spanId = TEST_SPAN_ID
      parentId = TEST_PARENT_ID
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

    it('injects trace context to Eventbridge putEvents when payload stays below 1mb', () => {
      const eventbridge = new EventBridge(tracer)
      const request = {
        params: {
          Entries: [
            {
              Detail: makeEventDetailForInjectedSize(EVENTBRIDGE_EVENT_MAX_BYTES - 1),
            },
          ],
        },
        operation: 'putEvents',
      }

      traceId = TEST_TRACE_ID
      spanId = TEST_SPAN_ID
      parentId = TEST_PARENT_ID
      eventbridge.requestInject(span.context(), request)

      assert.strictEqual(Buffer.byteLength(request.params.Entries[0].Detail), EVENTBRIDGE_EVENT_MAX_BYTES - 1)
      assert.deepStrictEqual(JSON.parse(request.params.Entries[0].Detail)._datadog, TEST_DATADOG_CONTEXT)
    })

    it('skips injecting trace context to Eventbridge if message is full', () => {
      const eventbridge = new EventBridge(tracer)
      const request = {
        params: {
          Entries: [
            {
              Detail: makeEventDetailForInjectedSize(EVENTBRIDGE_EVENT_MAX_BYTES),
            },
          ],
        },
        operation: 'putEvents',
      }

      traceId = TEST_TRACE_ID
      spanId = TEST_SPAN_ID
      parentId = TEST_PARENT_ID
      const originalDetail = request.params.Entries[0].Detail
      eventbridge.requestInject(span.context(), request)

      assert.strictEqual(request.params.Entries[0].Detail, originalDetail)
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
