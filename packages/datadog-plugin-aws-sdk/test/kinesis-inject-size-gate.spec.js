'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { describe, it } = require('mocha')

const Kinesis = require('../src/services/kinesis')
const { PATHWAY_HASH } = require('../../../ext/tags')

const KINESIS_MAX_RECORD_BYTES = 1_048_576
// The pathway field `dd-pathway-ctx-base64` the DSM path appends after the gate: a 21-char key,
// a 28-char base64 value and JSON framing. 55 bytes when it joins a non-empty carrier (trace
// context present), 54 when it is the only key (DSM-only). Kept in sync with the reserve in
// kinesis.js by pinning the boundary below.
const PATHWAY_FIELD_BYTES = 55
const PATHWAY_HASH_VALUE = '1234567890'

/**
 * `Object.create(Kinesis.prototype)` skips the heavy constructor wiring in
 * `BaseAwsSdkPlugin`; `injectToMessage` only touches `this.tracer`, `this.config`
 * and the real `this.setDSMCheckpoint`, so a hand-rolled stub suffices (matching
 * the retained `sqs-inject-to-message` / `stepfunctions-request-inject` specs).
 *
 * `tracer.setCheckpoint` is the single funnel the real `DataStreamsProcessor` uses to
 * both record the produce checkpoint and tag `pathway.hash` on the span, so the stub
 * mirrors that tagging and counts each call. A checkpoint is recorded if and only if
 * `setCheckpoint` was called — the invariant the size gate must protect.
 *
 * @param {object} options
 * @param {boolean} [options.dsmEnabled]
 * @param {(span: object, format: string, info: object) => boolean} [options.inject]
 * @returns {Kinesis & { setCheckpointCalls: number }}
 */
function buildPlugin ({ dsmEnabled = false, inject = () => false } = {}) {
  const plugin = Object.create(Kinesis.prototype)
  plugin.setCheckpointCalls = 0
  // `tracer` is a getter on the base Plugin class that reads `_tracer`.
  plugin._tracer = {
    inject,
    setCheckpoint (tags, span, payloadSize) {
      plugin.setCheckpointCalls += 1
      // Mirror DataStreamsProcessor.recordCheckpoint tagging the span with the pathway hash.
      span?.setTag(PATHWAY_HASH, PATHWAY_HASH_VALUE)
      return { hash: Buffer.alloc(8), pathwayStartNs: 0, edgeStartNs: 0 }
    },
  }
  plugin.config = { dsmEnabled }
  return plugin
}

/**
 * @param {object} [tags] Backing store the returned span records tags into.
 * @returns {{ setTag: (key: string, value: string) => void, tags: object }}
 */
function fakeSpan (tags = {}) {
  return { tags, setTag (key, value) { tags[key] = value } }
}

/**
 * Builds a `putRecord`-style params object whose JSON payload — once `_datadog` holds
 * `datadogFieldBytes` bytes — serializes to exactly `targetBytes`, so a test can straddle
 * the 1 MiB boundary deterministically (the mock agent can't: real trace headers vary in
 * length by more than the 55-byte reserve window).
 *
 * @param {number} targetBytes Desired byte length of `JSON.stringify(parsedData)`.
 * @param {number} datadogFieldBytes Byte length the injected `_datadog` object serializes to.
 * @returns {{ Data: Buffer }}
 */
function paramsOfSerializedSize (targetBytes, datadogFieldBytes) {
  // {"myData":"<filler>","_datadog":<datadogField>}
  const framing = '{"myData":"","_datadog":}'.length
  const fillerBytes = targetBytes - framing - datadogFieldBytes
  const data = JSON.stringify({ myData: 'a'.repeat(fillerBytes) })
  return { Data: Buffer.from(data, 'utf8') }
}

describe('Kinesis plugin injectToMessage reserves the DSM pathway field before the size gate', () => {
  // Trace context the stubbed inject writes; a fixed-size object so the payload size is exact.
  const traceContext = { 'x-datadog-trace-id': '1', 'x-datadog-parent-id': '11' }
  const traceContextBytes = Buffer.byteLength(JSON.stringify(traceContext), 'utf8')
  const inject = (span, format, info) => {
    Object.assign(info, traceContext)
    return true
  }
  const emptyDatadogBytes = Buffer.byteLength('{}', 'utf8')

  it('records the checkpoint and writes an under-cap record at the last size that still fits', () => {
    const plugin = buildPlugin({ dsmEnabled: true, inject })
    const span = fakeSpan()
    // Trace-context payload cap - 56: adding the 55-byte pathway field lands exactly at cap - 1.
    const params = paramsOfSerializedSize(KINESIS_MAX_RECORD_BYTES - PATHWAY_FIELD_BYTES - 1, traceContextBytes)
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', true)

    assert.strictEqual(plugin.setCheckpointCalls, 1)
    assert.strictEqual(span.tags[PATHWAY_HASH], PATHWAY_HASH_VALUE)
    assert.notStrictEqual(params.Data, originalData)
    assert.ok(params.Data.length < KINESIS_MAX_RECORD_BYTES, `wrote ${params.Data.length} bytes`)
    const written = JSON.parse(params.Data.toString('utf8'))
    assert.strictEqual(typeof written._datadog['dd-pathway-ctx-base64'], 'string')
  })

  it('records no checkpoint and leaves Data untouched at the first size that no longer fits', () => {
    const plugin = buildPlugin({ dsmEnabled: true, inject })
    const span = fakeSpan()
    // Trace-context payload cap - 55: the reserved pathway field would tip it to the cap.
    const params = paramsOfSerializedSize(KINESIS_MAX_RECORD_BYTES - PATHWAY_FIELD_BYTES, traceContextBytes)
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', true)

    assert.strictEqual(plugin.setCheckpointCalls, 0)
    assert.strictEqual(span.tags[PATHWAY_HASH], undefined)
    assert.strictEqual(params.Data, originalData)
  })

  it('never writes an over-cap record when the pathway field tips a just-under-cap record over', () => {
    const plugin = buildPlugin({ dsmEnabled: true, inject })
    const span = fakeSpan()
    // One byte under the cap before the pathway field: the pre-fix regression window.
    const params = paramsOfSerializedSize(KINESIS_MAX_RECORD_BYTES - 1, traceContextBytes)
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', true)

    assert.strictEqual(plugin.setCheckpointCalls, 0)
    assert.strictEqual(span.tags[PATHWAY_HASH], undefined)
    assert.strictEqual(params.Data, originalData)
    assert.ok(params.Data.length < KINESIS_MAX_RECORD_BYTES, `wrote ${params.Data.length} bytes`)
  })

  it('reserves the pathway field on the DSM-only path at the last size that still fits', () => {
    const plugin = buildPlugin({ dsmEnabled: true })
    const span = fakeSpan()
    const params = paramsOfSerializedSize(KINESIS_MAX_RECORD_BYTES - PATHWAY_FIELD_BYTES - 1, emptyDatadogBytes)

    plugin.injectToMessage(span, params, 'my-stream', false)

    assert.strictEqual(plugin.setCheckpointCalls, 1)
    assert.strictEqual(span.tags[PATHWAY_HASH], PATHWAY_HASH_VALUE)
    assert.ok(params.Data.length < KINESIS_MAX_RECORD_BYTES, `wrote ${params.Data.length} bytes`)
    const written = JSON.parse(params.Data.toString('utf8'))
    assert.strictEqual(typeof written._datadog['dd-pathway-ctx-base64'], 'string')
  })

  it('records no checkpoint on the DSM-only path at the first size that no longer fits', () => {
    const plugin = buildPlugin({ dsmEnabled: true })
    const span = fakeSpan()
    const params = paramsOfSerializedSize(KINESIS_MAX_RECORD_BYTES - PATHWAY_FIELD_BYTES, emptyDatadogBytes)
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', false)

    assert.strictEqual(plugin.setCheckpointCalls, 0)
    assert.strictEqual(span.tags[PATHWAY_HASH], undefined)
    assert.strictEqual(params.Data, originalData)
  })
})
