'use strict'

/**
 * Guardrail telemetry counters shared between the main thread and the debugger worker thread.
 *
 * Guardrail decisions are made in two places: the probe sampler that runs inside the V8 breakpoint condition on the
 * main thread (rate limits) and the debugger worker (capture limits, queue overflow). Neither should pay for a message
 * or a telemetry API call per skipped, dropped or incomplete event, so both increment counters in a shared buffer using
 * atomics, and the main thread periodically drains the counters into instrumentation telemetry metrics.
 *
 * The metric names, tags and reason codes are defined by the "Debugger Observability for GA" specification and are
 * shared with the other tracers. All metrics are counts in the `live_debugger` telemetry namespace.
 */

const TELEMETRY_NAMESPACE = 'live_debugger'

const EVENT_TYPE = Object.freeze({
  SNAPSHOT: 0,
  LOG: 1,
  DIAGNOSTIC: 2,
})
const EVENT_TYPE_NAMES = ['snapshot', 'log', 'diagnostic']

/** Attempts stopped before event creation (`events.skipped`) */
const SKIPPED_REASON = Object.freeze({
  RATE_LIMIT_GLOBAL: 0,
  RATE_LIMIT_PROBE: 1,
  EVALUATION_TIMEOUT: 2,
})
const SKIPPED_REASON_NAMES = ['rateLimitGlobal', 'rateLimitProbe', 'evaluationTimeout']

/** Complete events dropped before transport (`events.dropped`) */
const DROPPED_REASON = Object.freeze({
  QUEUE_FULL: 0,
  PAYLOAD_TOO_LARGE: 1,
})
const DROPPED_REASON_NAMES = ['queueFull', 'payloadTooLarge']

/**
 * Capture enforced limits (`capture.incomplete`). These are bit flags so that the reasons hit while producing a single
 * event can be accumulated in a bitmask and reported once per event per reason.
 */
const INCOMPLETE_REASON = Object.freeze({
  RUNTIME_ERROR: 1 << 0,
  TIMEOUT: 1 << 1,
  DEPTH: 1 << 2,
  FIELD_COUNT: 1 << 3,
  COLLECTION_SIZE: 1 << 4,
  STRING_LENGTH: 1 << 5,
  PAYLOAD_TOO_LARGE: 1 << 6,
  OTHER: 1 << 7,
})
const INCOMPLETE_REASON_NAMES = [
  'runtimeError', 'timeout', 'depth', 'fieldCount', 'collectionSize', 'stringLength', 'payloadTooLarge', 'other',
]

const EVENT_TYPE_COUNT = EVENT_TYPE_NAMES.length
const SKIPPED_OFFSET = 0
const DROPPED_OFFSET = SKIPPED_OFFSET + SKIPPED_REASON_NAMES.length * EVENT_TYPE_COUNT
const INCOMPLETE_OFFSET = DROPPED_OFFSET + DROPPED_REASON_NAMES.length * EVENT_TYPE_COUNT
const SLOT_COUNT = INCOMPLETE_OFFSET + INCOMPLETE_REASON_NAMES.length * EVENT_TYPE_COUNT

/**
 * @typedef {object} MetricSlot
 * @property {string} metric - The telemetry metric name
 * @property {string[]} tags - The telemetry tags, sorted
 */

/** @type {MetricSlot[]} */
const SLOTS = []
addSlots('events.skipped', SKIPPED_REASON_NAMES)
addSlots('events.dropped', DROPPED_REASON_NAMES)
addSlots('capture.incomplete', INCOMPLETE_REASON_NAMES)

class GuardrailMetrics {
  /** @type {Int32Array} */
  #counters

  /**
   * @param {SharedArrayBuffer} buffer - A buffer created with {@link GuardrailMetrics.createBuffer}
   */
  constructor (buffer) {
    this.#counters = new Int32Array(buffer)
  }

  /**
   * Create the shared buffer backing the counters.
   *
   * @returns {SharedArrayBuffer}
   */
  static createBuffer () {
    return new SharedArrayBuffer(SLOT_COUNT * Int32Array.BYTES_PER_ELEMENT)
  }

  /**
   * Record an attempt that was stopped before an event was created.
   *
   * @param {number} reason - One of {@link SKIPPED_REASON}
   * @param {number} eventType - One of {@link EVENT_TYPE}
   */
  eventSkipped (reason, eventType) {
    Atomics.add(this.#counters, SKIPPED_OFFSET + reason * EVENT_TYPE_COUNT + eventType, 1)
  }

  /**
   * Record a complete event that was dropped before transport.
   *
   * @param {number} reason - One of {@link DROPPED_REASON}
   * @param {number} eventType - One of {@link EVENT_TYPE}
   * @param {number} [count] - The number of dropped events
   */
  eventDropped (reason, eventType, count = 1) {
    Atomics.add(this.#counters, DROPPED_OFFSET + reason * EVENT_TYPE_COUNT + eventType, count)
  }

  /**
   * Record the capture limits enforced while producing a single event, once per reason.
   *
   * @param {number} reasons - A bitmask of {@link INCOMPLETE_REASON} flags
   * @param {number} eventType - One of {@link EVENT_TYPE}
   */
  captureIncomplete (reasons, eventType) {
    for (let bit = 0; reasons !== 0; bit++, reasons >>>= 1) {
      if ((reasons & 1) === 1) {
        Atomics.add(this.#counters, INCOMPLETE_OFFSET + bit * EVENT_TYPE_COUNT + eventType, 1)
      }
    }
  }

  /**
   * Reset all counters and report the ones that were non-zero.
   *
   * @param {(metric: string, tags: string[], count: number) => void} report - Called once per non-zero counter
   */
  drain (report) {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const count = Atomics.exchange(this.#counters, i, 0)
      if (count !== 0) {
        const { metric, tags } = SLOTS[i]
        report(metric, tags, count)
      }
    }
  }
}

/**
 * @param {string} metric
 * @param {string[]} reasonNames
 */
function addSlots (metric, reasonNames) {
  for (const reason of reasonNames) {
    for (const eventType of EVENT_TYPE_NAMES) {
      SLOTS.push({ metric, tags: [`event_type:${eventType}`, `reason:${reason}`] })
    }
  }
}

module.exports = {
  DROPPED_REASON,
  EVENT_TYPE,
  GuardrailMetrics,
  INCOMPLETE_REASON,
  SKIPPED_REASON,
  TELEMETRY_NAMESPACE,
}
