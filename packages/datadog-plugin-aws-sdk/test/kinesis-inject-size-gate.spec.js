'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { describe, it } = require('mocha')

const Kinesis = require('../src/services/kinesis')
const { PATHWAY_HASH } = require('../../../ext/tags')

const KINESIS_DEFAULT_MAX_RECORD_BYTES = 1_048_576
// The pathway field `dd-pathway-ctx-base64` the DSM path appends after the gate: a 21-char key,
// a 28-char base64 value and JSON framing. 55 bytes when it joins a non-empty carrier (trace
// context present), 54 when it is the only key (DSM-only). Kept in sync with the reserve in
// kinesis.js by pinning the boundary below.
const PATHWAY_FIELD_BYTES = 55
const PATHWAY_HASH_VALUE = '1234567890'
const DEFAULT_DATA_STREAMS_CONTEXT = {
  hash: Buffer.alloc(8),
  pathwayStartNs: 0,
  edgeStartNs: 0,
}

/** @typedef {Kinesis & { setCheckpointCalls: number }} TestKinesis */
/** @typedef {import('../../../dd-trace/src/opentracing/span')} DatadogSpan */
/** @typedef {DatadogSpan & { tags: Record<string, unknown> }} TestSpan */

/**
 * @param {object} options
 * @param {boolean} [options.dsmEnabled]
 * @param {(span: object, format: string) => object | undefined} [options.inject]
 * @param {() => object | undefined} [options.getDataStreamsContext]
 * @returns {TestKinesis}
 */
function buildPlugin ({
  dsmEnabled = false,
  inject = () => undefined,
  getDataStreamsContext = () => DEFAULT_DATA_STREAMS_CONTEXT,
} = {}) {
  const tracer = {
    inject,
    /**
     * @param {string[]} tags
     * @param {{ setTag: (key: string, value: string) => void } | undefined} span
     * @param {number} payloadSize
     * @returns {object | undefined}
     */
    setCheckpoint (tags, span, payloadSize) {
      plugin.setCheckpointCalls += 1
      const dataStreamsContext = getDataStreamsContext()
      if (!dataStreamsContext) return
      span?.setTag(PATHWAY_HASH, PATHWAY_HASH_VALUE)
      return dataStreamsContext
    },
  }
  const plugin = /** @type {TestKinesis} */ (new Kinesis(tracer, {}))
  plugin.setCheckpointCalls = 0
  plugin.config = { dsmEnabled }
  return plugin
}

/**
 * @param {Record<string, unknown>} [tags] Backing store the returned span records tags into.
 * @returns {TestSpan}
 */
function fakeSpan (tags = {}) {
  /**
   * @param {string} key
   * @param {unknown} value
   */
  function setTag (key, value) {
    tags[key] = value
  }
  return /** @type {TestSpan} */ ({ tags, setTag })
}

/**
 * @param {number} targetBytes Desired record size after trace context, pathway and partition key.
 * @param {number} datadogFieldBytes Byte length the injected `_datadog` object serializes to.
 * @param {string} partitionKey
 * @returns {{ Data: Buffer, PartitionKey: string }}
 */
function paramsOfRecordSize (targetBytes, datadogFieldBytes, partitionKey) {
  // {"myData":"<filler>","_datadog":<datadogField>}
  const framing = '{"myData":"","_datadog":}'.length
  const fillerBytes = targetBytes -
    Buffer.byteLength(partitionKey, 'utf8') -
    PATHWAY_FIELD_BYTES -
    framing -
    datadogFieldBytes
  const data = JSON.stringify({ myData: 'a'.repeat(fillerBytes) })
  return { Data: Buffer.from(data, 'utf8'), PartitionKey: partitionKey }
}

describe('Kinesis plugin injectToMessage reserves the DSM pathway field before the size gate', () => {
  // Trace context the stubbed inject writes; a fixed-size object so the payload size is exact.
  const traceContext = { 'x-datadog-trace-id': '1', 'x-datadog-parent-id': '11' }
  const traceContextBytes = Buffer.byteLength(JSON.stringify(traceContext), 'utf8')
  const inject = () => ({ ...traceContext })
  const emptyDatadogBytes = Buffer.byteLength('{}', 'utf8')
  const partitionKey = 'p'.repeat(256)
  const partitionKeyBytes = Buffer.byteLength(partitionKey, 'utf8')

  it('leaves Data untouched when neither trace nor DSM writes context', () => {
    const plugin = buildPlugin()
    const params = { Data: Buffer.from('{"myData":"value"}'), PartitionKey: partitionKey }
    const originalData = params.Data

    plugin.injectToMessage(fakeSpan(), params, 'my-stream', true)

    assert.strictEqual(params.Data, originalData)
  })

  it('writes trace context without DSM or a partition key', () => {
    const plugin = buildPlugin({ inject })
    const params = { Data: Buffer.from('{"myData":"value"}') }

    plugin.injectToMessage(fakeSpan(), params, 'my-stream', true)

    const written = JSON.parse(params.Data.toString('utf8'))
    assert.strictEqual(written._datadog['x-datadog-trace-id'], '1')
  })

  it('keeps trace context when DSM yields no pathway context', () => {
    const plugin = buildPlugin({ dsmEnabled: true, inject, getDataStreamsContext: () => undefined })
    const params = { Data: Buffer.from('{"myData":"value"}'), PartitionKey: partitionKey }

    plugin.injectToMessage(fakeSpan(), params, 'my-stream', true)

    assert.strictEqual(plugin.setCheckpointCalls, 1)
    const written = JSON.parse(params.Data.toString('utf8'))
    assert.deepStrictEqual(written._datadog, traceContext)
  })

  it('leaves Data untouched when a DSM checkpoint yields no pathway context', () => {
    const plugin = buildPlugin({ dsmEnabled: true, getDataStreamsContext: () => undefined })
    const params = { Data: Buffer.from('{"myData":"value"}'), PartitionKey: partitionKey }
    const originalData = params.Data

    plugin.injectToMessage(fakeSpan(), params, 'my-stream', false)

    assert.strictEqual(plugin.setCheckpointCalls, 1)
    assert.strictEqual(params.Data, originalData)
  })

  it('records the checkpoint at the exact default record-size limit', () => {
    const plugin = buildPlugin({ dsmEnabled: true, inject })
    const span = fakeSpan()
    const params = paramsOfRecordSize(KINESIS_DEFAULT_MAX_RECORD_BYTES, traceContextBytes, partitionKey)
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', true)

    assert.strictEqual(plugin.setCheckpointCalls, 1)
    assert.strictEqual(span.tags[PATHWAY_HASH], PATHWAY_HASH_VALUE)
    assert.notStrictEqual(params.Data, originalData)
    assert.strictEqual(params.Data.length + partitionKeyBytes, KINESIS_DEFAULT_MAX_RECORD_BYTES)
    const written = JSON.parse(params.Data.toString('utf8'))
    assert.strictEqual(typeof written._datadog['dd-pathway-ctx-base64'], 'string')
  })

  it('records no checkpoint one byte beyond the default record-size limit', () => {
    const plugin = buildPlugin({ dsmEnabled: true, inject })
    const span = fakeSpan()
    const params = paramsOfRecordSize(KINESIS_DEFAULT_MAX_RECORD_BYTES + 1, traceContextBytes, partitionKey)
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', true)

    assert.strictEqual(plugin.setCheckpointCalls, 0)
    assert.strictEqual(span.tags[PATHWAY_HASH], undefined)
    assert.strictEqual(params.Data, originalData)
  })

  it('counts the partition key before recording a checkpoint', () => {
    const plugin = buildPlugin({ dsmEnabled: true, inject })
    const span = fakeSpan()
    const params = paramsOfRecordSize(KINESIS_DEFAULT_MAX_RECORD_BYTES + 1, traceContextBytes, partitionKey)
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', true)

    assert.strictEqual(plugin.setCheckpointCalls, 0)
    assert.strictEqual(span.tags[PATHWAY_HASH], undefined)
    assert.strictEqual(params.Data, originalData)
    assert.ok(
      params.Data.length + PATHWAY_FIELD_BYTES < KINESIS_DEFAULT_MAX_RECORD_BYTES,
      'fixture must only cross the limit after adding its partition key'
    )
  })

  it('reserves the pathway field on the DSM-only path at the exact gate limit', () => {
    const plugin = buildPlugin({ dsmEnabled: true })
    const span = fakeSpan()
    const params = paramsOfRecordSize(KINESIS_DEFAULT_MAX_RECORD_BYTES, emptyDatadogBytes, partitionKey)

    plugin.injectToMessage(span, params, 'my-stream', false)

    assert.strictEqual(plugin.setCheckpointCalls, 1)
    assert.strictEqual(span.tags[PATHWAY_HASH], PATHWAY_HASH_VALUE)
    assert.ok(params.Data.length + partitionKeyBytes <= KINESIS_DEFAULT_MAX_RECORD_BYTES)
    const written = JSON.parse(params.Data.toString('utf8'))
    assert.strictEqual(typeof written._datadog['dd-pathway-ctx-base64'], 'string')
  })

  it('records no checkpoint one byte beyond the DSM-only gate limit', () => {
    const plugin = buildPlugin({ dsmEnabled: true })
    const span = fakeSpan()
    const params = paramsOfRecordSize(KINESIS_DEFAULT_MAX_RECORD_BYTES + 1, emptyDatadogBytes, partitionKey)
    const originalData = params.Data

    plugin.injectToMessage(span, params, 'my-stream', false)

    assert.strictEqual(plugin.setCheckpointCalls, 0)
    assert.strictEqual(span.tags[PATHWAY_HASH], undefined)
    assert.strictEqual(params.Data, originalData)
  })
})
