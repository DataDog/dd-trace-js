'use strict'

const assert = require('node:assert/strict')

const { before, describe, it } = require('mocha')
const sinon = require('sinon')

const EventBridge = require('../src/services/eventbridge')
const tracer = require('../../dd-trace')
const { withAwsSdkVersions } = require('./spec_helpers')

const EVENTBRIDGE_EVENT_MAX_BYTES = 1024 * 1024

// The propagation headers the tracer injects for `span`, and the bytes they add to a detail.
let expectedContext
let expectedContextBytes

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
  return makeEventDetail(size - expectedContextBytes)
}

describe('EventBridge', () => {
  let span
  withAwsSdkVersions((version, moduleName) => {
    before(() => {
      tracer.init()
      // A hand-rolled span context cannot satisfy the propagators, which silently drop the whole
      // injection when one of them throws.
      span = tracer.startSpan('aws.request')
      expectedContext = tracer._tracer.inject(span.context(), 'text_map')
      expectedContextBytes = Buffer.byteLength(`,"_datadog":${JSON.stringify(expectedContext)}`)
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

      eventbridge.requestInject(span.context(), request)

      assert.deepStrictEqual(request.params, {
        Entries: [{
          Detail: '{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":' +
            `${JSON.stringify(expectedContext)}}`,
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

      eventbridge.requestInject(span.context(), request)

      assert.strictEqual(Buffer.byteLength(request.params.Entries[0].Detail), EVENTBRIDGE_EVENT_MAX_BYTES - 1)
      assert.deepStrictEqual(JSON.parse(request.params.Entries[0].Detail)._datadog, expectedContext)
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

      const originalDetail = request.params.Entries[0].Detail
      eventbridge.requestInject(span.context(), request)

      assert.strictEqual(request.params.Entries[0].Detail, originalDetail)
    })

    it('skips injecting when the batched entries exceed 1mb in total', () => {
      const eventbridge = new EventBridge(tracer)
      const request = {
        params: {
          Entries: [
            { Detail: makeEventDetailForInjectedSize(550 * 1024) },
            { Detail: makeEventDetail(550 * 1024) },
            { Detail: makeEventDetail(100 * 1024) },
          ],
        },
        operation: 'putEvents',
      }

      const originalDetails = request.params.Entries.map((entry) => entry.Detail)
      eventbridge.requestInject(span.context(), request)

      assert.deepStrictEqual(request.params.Entries.map((entry) => entry.Detail), originalDetails)
    })

    it('accounts for Source, DetailType, Time, and Resources when sizing the request', () => {
      const eventbridge = new EventBridge(tracer)
      const request = {
        params: {
          Entries: [
            {
              Detail: makeEventDetailForInjectedSize(EVENTBRIDGE_EVENT_MAX_BYTES - 50),
              Source: 'my.svc',
              DetailType: 'my.type',
              Time: new Date(),
              Resources: ['a'.repeat(100), null],
            },
          ],
        },
        operation: 'putEvents',
      }

      const originalDetail = request.params.Entries[0].Detail
      eventbridge.requestInject(span.context(), request)

      assert.strictEqual(request.params.Entries[0].Detail, originalDetail)
    })

    it('injects trace context when the full batched request stays below 1mb', () => {
      const eventbridge = new EventBridge(tracer)
      const request = {
        params: {
          Entries: [
            { Detail: makeEventDetailForInjectedSize(400 * 1024) },
            { Detail: makeEventDetail(EVENTBRIDGE_EVENT_MAX_BYTES - 1 - 400 * 1024) },
          ],
        },
        operation: 'putEvents',
      }

      const originalSecondDetail = request.params.Entries[1].Detail
      eventbridge.requestInject(span.context(), request)

      assert.deepStrictEqual(JSON.parse(request.params.Entries[0].Detail)._datadog, expectedContext)
      assert.strictEqual(request.params.Entries[1].Detail, originalSecondDetail)
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
