'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const getConfig = require('../../dd-trace/src/config')
const TextMapPropagator = require('../../dd-trace/src/opentracing/propagation/text_map')
const { convertToTextMap, getKafkaMessageSize } = require('../src/utils')

describe('convertToTextMap', () => {
  it('reports absent headers as null so the caller skips extraction', () => {
    assert.strictEqual(convertToTextMap(undefined), null)
    assert.strictEqual(convertToTextMap(null), null)
  })

  it('converts scalar string and Buffer values', () => {
    assert.deepStrictEqual(convertToTextMap({
      text: 'value',
      binary: Buffer.from('buffer'),
    }), {
      text: 'value',
      binary: 'buffer',
    })
  })

  it('collapses repeated KafkaJS values to the last one', () => {
    assert.deepStrictEqual(convertToTextMap({
      traceparent: [Buffer.from('first'), Buffer.from('second'), Buffer.from('third')],
    }), {
      traceparent: 'third',
    })
  })

  it('collapses one repeated KafkaJS header value to a scalar', () => {
    assert.deepStrictEqual(convertToTextMap({
      traceparent: [Buffer.from('current')],
    }), {
      traceparent: 'current',
    })
  })

  it('skips a repeated KafkaJS header without values', () => {
    assert.deepStrictEqual(convertToTextMap({ traceparent: [] }), {})
  })

  it('falls back to the last usable value when the repeated tail is nullish', () => {
    assert.deepStrictEqual(convertToTextMap({
      traceparent: [Buffer.from('current'), undefined, null],
    }), {
      traceparent: 'current',
    })
  })

  it('skips nullish scalar values', () => {
    assert.deepStrictEqual(convertToTextMap({
      first: null,
      second: undefined,
    }), {})
  })

  it('collapses repeated native-list values to the last one', () => {
    assert.deepStrictEqual(convertToTextMap([
      { traceparent: Buffer.from('stale') },
      { traceparent: Buffer.from('current') },
    ]), {
      traceparent: 'current',
    })
  })

  it('skips nullish native-list values instead of throwing on them', () => {
    assert.deepStrictEqual(convertToTextMap([
      { first: null },
      { second: undefined },
    ]), {})
  })

  it('keeps an earlier native-list value that a nullish repeat would erase', () => {
    assert.deepStrictEqual(convertToTextMap([
      { traceparent: Buffer.from('current') },
      { traceparent: undefined },
    ]), {
      traceparent: 'current',
    })
  })

  it('extracts a trace id the producer actually sent when the field repeats', () => {
    const carrier = convertToTextMap([
      { 'x-datadog-trace-id': Buffer.from('123') },
      { 'x-datadog-trace-id': Buffer.from('456') },
      { 'x-datadog-parent-id': Buffer.from('789') },
    ])
    const extracted = new TextMapPropagator(getConfig()).extract(carrier)

    assert.strictEqual(extracted.toTraceId(), '456')
    assert.strictEqual(extracted.toSpanId(), '789')
  })
})

describe('getKafkaMessageSize', () => {
  it('sizes a message without headers', () => {
    assert.strictEqual(getKafkaMessageSize({ key: 'key', value: 'value' }), 8)
  })

  it('sizes a message with null headers', () => {
    assert.strictEqual(getKafkaMessageSize({ key: 'key', value: 'value', headers: null }), 8)
  })

  it('sizes scalar string and Buffer header values', () => {
    assert.strictEqual(getKafkaMessageSize({
      key: Buffer.from('k'),
      value: Buffer.from('v'),
      headers: {
        text: 'abc',
        binary: Buffer.from([1, 2]),
      },
    }), 17)
  })

  it('counts an undefined header value as key-only', () => {
    assert.strictEqual(getKafkaMessageSize({
      headers: { optional: undefined },
    }), 8)
  })

  it('counts no bytes for an empty repeated-value array', () => {
    assert.strictEqual(getKafkaMessageSize({
      key: 'key',
      value: 'value',
      headers: { 'content-type': [] },
    }), 8)
  })

  it('counts one key for a single repeated value', () => {
    assert.strictEqual(getKafkaMessageSize({
      key: 'key',
      value: 'value',
      headers: { 'content-type': ['text'] },
    }), 24)
  })

  it('counts one key for every repeated map value', () => {
    assert.strictEqual(getKafkaMessageSize({
      key: 'key',
      value: 'value',
      headers: {
        'content-type': ['text', Buffer.from('application/json')],
      },
    }), 52)
  })

  it('counts every native list entry independently', () => {
    assert.strictEqual(getKafkaMessageSize({
      key: 'key',
      value: 'value',
      headers: [
        { 'content-type': 'text' },
        { 'content-type': Buffer.from('application/json') },
      ],
    }), 52)
  })

  it('counts no bytes for an empty native header list', () => {
    assert.strictEqual(getKafkaMessageSize({
      key: 'key',
      value: 'value',
      headers: [],
    }), 8)
  })
})
