'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { getAllBaggageItems } = require('../../dd-trace/src/baggage')
const getConfig = require('../../dd-trace/src/config')
const TextMapPropagator = require('../../dd-trace/src/opentracing/propagation/text_map')
const { convertToTextMap, getKafkaMessageSize } = require('../src/utils')

/** @param {Record<string, string | string[]> | null} source */
const nullPrototype = (source) => source && Object.assign(Object.create(null), source)

describe('convertToTextMap', () => {
  const conversions = [
    ['reports absent headers as null so the caller skips extraction', undefined, null],
    ['reports null headers as null', null, null],
    [
      'converts scalar string and Buffer values',
      { text: 'value', binary: Buffer.from('buffer') },
      { text: 'value', binary: 'buffer' },
    ],
    [
      'keeps every repeated KafkaJS value in wire order',
      { traceparent: [Buffer.from('first'), Buffer.from('second'), Buffer.from('third')] },
      { traceparent: ['first', 'second', 'third'] },
    ],
    [
      'collapses one repeated KafkaJS header value to a scalar',
      { traceparent: [Buffer.from('current')] },
      { traceparent: 'current' },
    ],
    ['skips a repeated KafkaJS header without values', { traceparent: [] }, {}],
    [
      'drops the nullish members of a repeated KafkaJS header',
      { traceparent: [Buffer.from('current'), undefined, null] },
      { traceparent: 'current' },
    ],
    [
      'keeps both usable members around a nullish one',
      { traceparent: [Buffer.from('first'), undefined, Buffer.from('third')] },
      { traceparent: ['first', 'third'] },
    ],
    ['skips nullish scalar values', { first: null, second: undefined }, {}],
    [
      'keeps every repeated native-list value in wire order',
      [{ traceparent: Buffer.from('stale') }, { traceparent: Buffer.from('current') }],
      { traceparent: ['stale', 'current'] },
    ],
    [
      'keeps a third repeat of a native-list field',
      [{ tracestate: Buffer.from('a=1') }, { tracestate: Buffer.from('b=2') }, { tracestate: Buffer.from('c=3') }],
      { tracestate: ['a=1', 'b=2', 'c=3'] },
    ],
    ['skips nullish native-list values instead of throwing on them', [{ first: null }, { second: undefined }], {}],
    [
      'keeps an earlier native-list value that a nullish repeat would erase',
      [{ traceparent: Buffer.from('current') }, { traceparent: undefined }],
      { traceparent: 'current' },
    ],
    [
      'treats a prototype-shadowing key as an ordinary header',
      { toString: Buffer.from('value'), ['__proto__']: Buffer.from('polluted') },
      { toString: 'value', ['__proto__']: 'polluted' },
    ],
    [
      'repeats a prototype-shadowing key without inheriting the prototype value',
      [{ toString: Buffer.from('first') }, { toString: Buffer.from('second') }],
      { toString: ['first', 'second'] },
    ],
  ]

  for (const [name, bufferMap, expected] of conversions) {
    it(name, () => {
      assert.deepStrictEqual(convertToTextMap(bufferMap), nullPrototype(expected))
    })
  }

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

  it('keeps every baggage item a producer sent across repeated fields', () => {
    const carrier = convertToTextMap([
      { baggage: Buffer.from('first=1') },
      { baggage: Buffer.from('second=2') },
    ])
    new TextMapPropagator(getConfig()).extract(carrier)

    assert.deepStrictEqual(getAllBaggageItems(), { first: '1', second: '2' })
  })
})

describe('getKafkaMessageSize', () => {
  const sizes = [
    ['sizes a message without headers', { key: 'key', value: 'value' }, 8],
    ['sizes a message with null headers', { key: 'key', value: 'value', headers: null }, 8],
    [
      'sizes scalar string and Buffer header values',
      { key: Buffer.from('k'), value: Buffer.from('v'), headers: { text: 'abc', binary: Buffer.from([1, 2]) } },
      17,
    ],
    ['counts an undefined header value as key-only', { headers: { optional: undefined } }, 8],
    [
      'counts no bytes for an empty repeated-value array',
      { key: 'key', value: 'value', headers: { 'content-type': [] } },
      8,
    ],
    [
      'counts one key for a single repeated value',
      { key: 'key', value: 'value', headers: { 'content-type': ['text'] } },
      24,
    ],
    [
      'counts one key for every repeated map value',
      { key: 'key', value: 'value', headers: { 'content-type': ['text', Buffer.from('application/json')] } },
      52,
    ],
    [
      'counts every native list entry independently',
      {
        key: 'key',
        value: 'value',
        headers: [{ 'content-type': 'text' }, { 'content-type': Buffer.from('application/json') }],
      },
      52,
    ],
    ['counts no bytes for an empty native header list', { key: 'key', value: 'value', headers: [] }, 8],
    [
      'skips native entries carrying no usable key',
      { key: 'key', value: 'value', headers: [{}, null, { 'content-type': 'text' }] },
      24,
    ],
    ['sizes a non-object native entry without throwing', { key: 'key', value: 'value', headers: [42] }, 9],
  ]

  for (const [name, message, expected] of sizes) {
    it(name, () => {
      assert.strictEqual(getKafkaMessageSize(message), expected)
    })
  }
})
