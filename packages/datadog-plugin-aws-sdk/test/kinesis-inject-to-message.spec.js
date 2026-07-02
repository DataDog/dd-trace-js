'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { describe, it } = require('mocha')

const Kinesis = require('../src/services/kinesis')
const { PATHWAY_HASH } = require('../../../ext/tags')

const KINESIS_MAX_RECORD_BYTES = 1_048_576
const PATHWAY_HASH_VALUE = '1234567890'

/**
 * `Object.create(Kinesis.prototype)` skips the heavy constructor wiring in
 * `BaseAwsSdkPlugin`; `injectToMessage` only touches `this.tracer`, `this.config`,
 * and `this.setDSMCheckpoint`, so a hand-rolled stub suffices.
 *
 * `tracer.setCheckpoint` is the single funnel the real `DataStreamsProcessor`
 * uses to both record the produce checkpoint and tag `pathway.hash` on the span,
 * so the stub mirrors that tagging and records each call. A checkpoint is recorded
 * if and only if `setCheckpoint` was called.
 *
 * @param {object} options
 * @param {boolean} [options.dsmEnabled]
 * @param {(span: object, format: string, info: object) => void} [options.inject]
 * @returns {Kinesis & {
 *   setCheckpointCalls: Array<{ tags: string[], span: object | null, payloadSize: number }>
 * }}
 */
function buildPlugin ({
  dsmEnabled = false,
  inject = () => {},
} = {}) {
  const plugin = Object.create(Kinesis.prototype)
  plugin.setCheckpointCalls = []
  // `tracer` is a getter on the base Plugin class that reads `_tracer`.
  plugin._tracer = {
    inject,
    setCheckpoint (tags, span, payloadSize) {
      plugin.setCheckpointCalls.push({ tags, span, payloadSize })
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
 * Builds a `putRecord`-style params object whose JSON payload — once `_datadog`
 * holds `datadogFieldBytes` bytes of trace context — serializes to exactly
 * `targetBytes`. Lets a test straddle the 1 MiB boundary deterministically.
 *
 * @param {number} targetBytes Desired byte length of `JSON.stringify(parsedData)`.
 * @param {number} [datadogFieldBytes] Byte length the injected `_datadog` object serializes to.
 * @returns {{ Data: Buffer }}
 */
function paramsOfSerializedSize (targetBytes, datadogFieldBytes = 2) {
  // {"myData":"<filler>","_datadog":<datadogField>}
  const framing = '{"myData":"","_datadog":}'.length
  const fillerBytes = targetBytes - framing - datadogFieldBytes
  const data = JSON.stringify({ myData: 'a'.repeat(fillerBytes) })
  return { Data: Buffer.from(data, 'utf8') }
}

describe('Kinesis plugin injectToMessage DSM checkpoint size gate', () => {
  // Trace context the stubbed inject writes; 42 bytes serialized as an object.
  const traceContext = { 'x-datadog-trace-id': '1', 'x-datadog-parent-id': '11' }
  const traceContextBytes = Buffer.byteLength(JSON.stringify(traceContext), 'utf8')
  const inject = (span, format, info) => Object.assign(info, traceContext)

  it('records no DSM checkpoint and writes no Data when the record is at the 1 MiB cap', () => {
    const plugin = buildPlugin({ dsmEnabled: true, inject })
    const span = fakeSpan()
    const params = paramsOfSerializedSize(KINESIS_MAX_RECORD_BYTES, traceContextBytes)
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', true)

    assert.strictEqual(plugin.setCheckpointCalls.length, 0)
    assert.strictEqual(span.tags[PATHWAY_HASH], undefined)
    assert.strictEqual(params.Data, originalData)
  })

  it('records no DSM checkpoint and writes no Data when the record is one byte past the cap', () => {
    const plugin = buildPlugin({ dsmEnabled: true, inject })
    const span = fakeSpan()
    const params = paramsOfSerializedSize(KINESIS_MAX_RECORD_BYTES + 1, traceContextBytes)
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', true)

    assert.strictEqual(plugin.setCheckpointCalls.length, 0)
    assert.strictEqual(span.tags[PATHWAY_HASH], undefined)
    assert.strictEqual(params.Data, originalData)
  })

  it('records the DSM checkpoint, tags pathway.hash and writes Data one byte under the cap', () => {
    const plugin = buildPlugin({ dsmEnabled: true, inject })
    const span = fakeSpan()
    const params = paramsOfSerializedSize(KINESIS_MAX_RECORD_BYTES - 1, traceContextBytes)
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', true)

    assert.strictEqual(plugin.setCheckpointCalls.length, 1)
    assert.deepStrictEqual(plugin.setCheckpointCalls[0].tags, ['direction:out', 'topic:my-stream', 'type:kinesis'])
    assert.strictEqual(span.tags[PATHWAY_HASH], PATHWAY_HASH_VALUE)
    assert.notStrictEqual(params.Data, originalData)
    const written = JSON.parse(params.Data.toString('utf8'))
    assert.strictEqual(written._datadog['x-datadog-trace-id'], '1')
    assert.strictEqual(typeof written._datadog['dd-pathway-ctx-base64'], 'string')
  })

  it('records the checkpoint for a DSM-only record with no trace context under the cap', () => {
    const plugin = buildPlugin({ dsmEnabled: true })
    const span = fakeSpan()
    const params = paramsOfSerializedSize(KINESIS_MAX_RECORD_BYTES - 1, 2)

    plugin.injectToMessage(span, params, 'my-stream', false)

    assert.strictEqual(plugin.setCheckpointCalls.length, 1)
    assert.strictEqual(span.tags[PATHWAY_HASH], PATHWAY_HASH_VALUE)
    const written = JSON.parse(params.Data.toString('utf8'))
    assert.strictEqual(typeof written._datadog['dd-pathway-ctx-base64'], 'string')
  })

  it('records no checkpoint for a DSM-only over-cap record', () => {
    const plugin = buildPlugin({ dsmEnabled: true })
    const span = fakeSpan()
    const params = paramsOfSerializedSize(KINESIS_MAX_RECORD_BYTES + 1, 2)
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', false)

    assert.strictEqual(plugin.setCheckpointCalls.length, 0)
    assert.strictEqual(span.tags[PATHWAY_HASH], undefined)
    assert.strictEqual(params.Data, originalData)
  })

  it('writes an under-cap trace-only record without a checkpoint when DSM is disabled', () => {
    const plugin = buildPlugin({ dsmEnabled: false, inject })
    const span = fakeSpan()
    const params = paramsOfSerializedSize(KINESIS_MAX_RECORD_BYTES - 1, traceContextBytes)

    plugin.injectToMessage(span, params, 'my-stream', true)

    assert.strictEqual(plugin.setCheckpointCalls.length, 0)
    assert.strictEqual(span.tags[PATHWAY_HASH], undefined)
    const written = JSON.parse(params.Data.toString('utf8'))
    assert.strictEqual(written._datadog['x-datadog-trace-id'], '1')
  })

  it('leaves Data untouched and records nothing when neither trace context nor DSM applies', () => {
    const plugin = buildPlugin({ dsmEnabled: false })
    const span = fakeSpan()
    const params = { Data: Buffer.from('{"myData":"x"}', 'utf8') }
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', false)

    assert.strictEqual(plugin.setCheckpointCalls.length, 0)
    assert.strictEqual(span.tags[PATHWAY_HASH], undefined)
    assert.strictEqual(params.Data, originalData)
  })
})
