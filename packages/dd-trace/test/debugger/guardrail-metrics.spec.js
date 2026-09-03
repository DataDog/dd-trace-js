'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
require('../setup/mocha')

const {
  DROPPED_REASON,
  EVENT_TYPE,
  GuardrailMetrics,
  INCOMPLETE_REASON,
  SKIPPED_REASON,
  TELEMETRY_NAMESPACE,
} = require('../../src/debugger/guardrail-metrics')

describe('debugger/guardrail-metrics', () => {
  /** @type {GuardrailMetrics} */
  let metrics
  /** @type {SharedArrayBuffer} */
  let buffer

  beforeEach(() => {
    buffer = GuardrailMetrics.createBuffer()
    metrics = new GuardrailMetrics(buffer)
  })

  it('should use the telemetry namespace shared with the other tracers', () => {
    assert.strictEqual(TELEMETRY_NAMESPACE, 'live_debugger')
  })

  it('should create a shared buffer', () => {
    assert.ok(buffer instanceof SharedArrayBuffer)
  })

  it('should report nothing when no counter was incremented', () => {
    assert.deepStrictEqual(drain(), [])
  })

  it('should report skipped events by reason and event type', () => {
    metrics.eventSkipped(SKIPPED_REASON.RATE_LIMIT_GLOBAL, EVENT_TYPE.SNAPSHOT)
    metrics.eventSkipped(SKIPPED_REASON.RATE_LIMIT_PROBE, EVENT_TYPE.SNAPSHOT)
    metrics.eventSkipped(SKIPPED_REASON.RATE_LIMIT_PROBE, EVENT_TYPE.SNAPSHOT)
    metrics.eventSkipped(SKIPPED_REASON.RATE_LIMIT_PROBE, EVENT_TYPE.LOG)
    metrics.eventSkipped(SKIPPED_REASON.EVALUATION_TIMEOUT, EVENT_TYPE.LOG)

    assert.deepStrictEqual(drain(), [
      ['events.skipped', ['event_type:snapshot', 'reason:rateLimitGlobal'], 1],
      ['events.skipped', ['event_type:snapshot', 'reason:rateLimitProbe'], 2],
      ['events.skipped', ['event_type:log', 'reason:rateLimitProbe'], 1],
      ['events.skipped', ['event_type:log', 'reason:evaluationTimeout'], 1],
    ])
  })

  it('should report dropped events by reason and event type', () => {
    metrics.eventDropped(DROPPED_REASON.QUEUE_FULL, EVENT_TYPE.DIAGNOSTIC)
    metrics.eventDropped(DROPPED_REASON.QUEUE_FULL, EVENT_TYPE.SNAPSHOT, 5)
    metrics.eventDropped(DROPPED_REASON.PAYLOAD_TOO_LARGE, EVENT_TYPE.LOG)

    assert.deepStrictEqual(drain(), [
      ['events.dropped', ['event_type:snapshot', 'reason:queueFull'], 5],
      ['events.dropped', ['event_type:diagnostic', 'reason:queueFull'], 1],
      ['events.dropped', ['event_type:log', 'reason:payloadTooLarge'], 1],
    ])
  })

  it('should report each incomplete capture reason once per event', () => {
    metrics.captureIncomplete(
      INCOMPLETE_REASON.DEPTH | INCOMPLETE_REASON.STRING_LENGTH | INCOMPLETE_REASON.OTHER,
      EVENT_TYPE.SNAPSHOT
    )
    metrics.captureIncomplete(INCOMPLETE_REASON.DEPTH, EVENT_TYPE.SNAPSHOT)
    metrics.captureIncomplete(
      INCOMPLETE_REASON.RUNTIME_ERROR | INCOMPLETE_REASON.TIMEOUT | INCOMPLETE_REASON.FIELD_COUNT |
        INCOMPLETE_REASON.COLLECTION_SIZE | INCOMPLETE_REASON.PAYLOAD_TOO_LARGE,
      EVENT_TYPE.LOG
    )
    metrics.captureIncomplete(0, EVENT_TYPE.LOG)

    assert.deepStrictEqual(drain(), [
      ['capture.incomplete', ['event_type:log', 'reason:runtimeError'], 1],
      ['capture.incomplete', ['event_type:log', 'reason:timeout'], 1],
      ['capture.incomplete', ['event_type:snapshot', 'reason:depth'], 2],
      ['capture.incomplete', ['event_type:log', 'reason:fieldCount'], 1],
      ['capture.incomplete', ['event_type:log', 'reason:collectionSize'], 1],
      ['capture.incomplete', ['event_type:snapshot', 'reason:stringLength'], 1],
      ['capture.incomplete', ['event_type:log', 'reason:payloadTooLarge'], 1],
      ['capture.incomplete', ['event_type:snapshot', 'reason:other'], 1],
    ])
  })

  it('should reset the counters when drained', () => {
    metrics.eventSkipped(SKIPPED_REASON.RATE_LIMIT_GLOBAL, EVENT_TYPE.SNAPSHOT)
    drain()

    assert.deepStrictEqual(drain(), [])
  })

  it('should share the counters between instances backed by the same buffer', () => {
    const other = new GuardrailMetrics(buffer)

    metrics.eventSkipped(SKIPPED_REASON.RATE_LIMIT_GLOBAL, EVENT_TYPE.SNAPSHOT)
    other.eventSkipped(SKIPPED_REASON.RATE_LIMIT_GLOBAL, EVENT_TYPE.SNAPSHOT)

    assert.deepStrictEqual(drain(), [
      ['events.skipped', ['event_type:snapshot', 'reason:rateLimitGlobal'], 2],
    ])
    assert.deepStrictEqual(drain(other), [])
  })

  /**
   * @param {GuardrailMetrics} [instance]
   * @returns {Array<[string, string[], number]>}
   */
  function drain (instance = metrics) {
    /** @type {Array<[string, string[], number]>} */
    const reported = []
    instance.drain((metric, tags, count) => reported.push([metric, tags, count]))
    return reported
  }
})
