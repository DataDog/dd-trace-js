'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')

require('./setup/core')
const { SAMPLING_PRIORITY_KEY, DECISION_MAKER_KEY } = require('../src/constants')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const agent = require('./plugins/agent')

describe('dd-trace', () => {
  let tracer

  beforeEach(() => {
    tracer = require('../')
    return agent.load()
  })

  afterEach(() => {
    agent.close()
  })

  it('should record and send a trace to the agent', () => {
    const span = tracer.startSpan('hello', {
      tags: {
        'resource.name': '/hello/:name',
      },
    })

    span.finish()

    return agent.assertSomeTraces((payload) => {
      assert.strictEqual(payload[0][0].trace_id.toString(), span.context()._traceId.toString(10))
      assert.strictEqual(payload[0][0].span_id.toString(), span.context()._spanId.toString(10))
      assertObjectContains(payload, {
        0: {
          0: {
            service: 'test',
            name: 'hello',
            resource: '/hello/:name',
          },
        },
      })
      assert.strictEqual(typeof payload[0][0].start, 'bigint')
      assert.strictEqual(typeof payload[0][0].duration, 'bigint')
      assert.ok(Object.hasOwn(payload[0][0].metrics, SAMPLING_PRIORITY_KEY))
      assert.ok(Object.hasOwn(payload[0][0].meta, DECISION_MAKER_KEY))
    })
  })
})
