'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { getAllBaggageItems } = require('../../dd-trace/src/baggage')
const getConfig = require('../../dd-trace/src/config')
const TextMapPropagator = require('../../dd-trace/src/opentracing/propagation/text_map')
const {
  convertToTextMap,
  getClusterIdEdgeTag,
  getGroupEdgeTag,
  getKafkaMessageSize,
  getTopicEdgeTag,
} = require('../src/utils')
const { getSizeOrZero } = require('../../dd-trace/src/datastreams')

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

  describe('header key size memo', () => {
    // The size formula without the header key memo or the inline value fast path.
    function referenceSize ({ key, value, headers }) {
      let size = getSizeOrZero(key) + getSizeOrZero(value)
      if (headers === undefined || headers === null) return size
      if (Array.isArray(headers)) return size + getSizeOrZero(headers)
      for (const headerKey of Object.keys(headers)) {
        const headerValue = headers[headerKey]
        const keySize = Buffer.byteLength(headerKey, 'utf8')
        size += (Array.isArray(headerValue) ? keySize * headerValue.length : keySize) + getSizeOrZero(headerValue)
      }
      return size
    }

    const messages = [
      ['string key and value', { key: 'key', value: 'value' }],
      ['Buffer key and value', { key: Buffer.from('k'), value: Buffer.from('vv') }],
      ['ArrayBuffer key and value', { key: new ArrayBuffer(3), value: new ArrayBuffer(5) }],
      ['Uint8Array key and value', { key: new Uint8Array([1, 2]), value: new Uint8Array([3, 4, 5]) }],
      ['number key and value', { key: 42, value: 1234 }],
      ['null key and value', { key: null, value: null }],
      ['undefined key and value', {}],
      ['non-ASCII string key and value', { key: 'clé', value: '\u{1F600}' }],
      ['lone surrogate value', { key: 'k', value: '\uD800' }],
      [
        'string, Buffer, undefined, number and null header values',
        { headers: { text: 'abc', binary: Buffer.from([1, 2]), missing: undefined, count: 7, empty: null } },
      ],
      [
        'repeated header values',
        { key: 'k', headers: { repeated: ['a', Buffer.from('bc'), undefined], none: [] } },
      ],
      [
        'non-ASCII header keys',
        { headers: { clé: 'v', '\u{1F600}': Buffer.from('v'), '\uD800': 'v', ключ: ['a', 'b'] } },
      ],
      ['native header list', { key: 'k', headers: [{ clé: 'text' }, { 'x-key': Buffer.from('abc') }, null] }],
      ['empty native header list', { key: 'k', headers: [] }],
      ['null headers', { key: 'k', headers: null }],
    ]

    for (const [name, message] of messages) {
      it(`matches the reference formula for ${name}`, () => {
        assert.strictEqual(getKafkaMessageSize(message), referenceSize(message))
      })
    }

    it('returns the same size when the same message is sized twice', () => {
      const message = { key: 'key', value: 'value', headers: { traceparent: 'abc', 'x-datadog-trace-id': '123' } }
      const first = getKafkaMessageSize(message)
      assert.strictEqual(getKafkaMessageSize(message), first)
    })

    it('stays correct after more than 1000 distinct header keys evicted the memo', () => {
      const distinctKeys = Array.from({ length: 1500 }, (_, index) => `header-key-${index}-\u00e9`)
      const messagesWithManyKeys = []
      for (let start = 0; start < distinctKeys.length; start += 10) {
        const headers = {}
        for (const headerKey of distinctKeys.slice(start, start + 10)) {
          headers[headerKey] = headerKey.length % 2 ? 'v' : ['a', 'b']
        }
        messagesWithManyKeys.push({ key: 'k', value: 'v', headers })
      }

      for (const message of messagesWithManyKeys) {
        assert.strictEqual(getKafkaMessageSize(message), referenceSize(message))
      }
      for (const message of messagesWithManyKeys.slice(0, 20)) {
        assert.strictEqual(getKafkaMessageSize(message), referenceSize(message))
      }
    })
  })
})

describe('edge tag helpers', () => {
  const helpers = [
    ['getTopicEdgeTag', getTopicEdgeTag, 'topic'],
    ['getGroupEdgeTag', getGroupEdgeTag, 'group'],
    ['getClusterIdEdgeTag', getClusterIdEdgeTag, 'kafka_cluster_id'],
  ]

  for (const [name, helper, prefix] of helpers) {
    describe(name, () => {
      it('returns the template literal string for string, undefined and number inputs', () => {
        for (const input of ['orders', undefined, 42]) {
          assert.strictEqual(helper(input), `${prefix}:${input}`)
          assert.strictEqual(helper(input), `${prefix}:${input}`)
        }
      })

      it('keeps returning correct strings after more than 1000 distinct inputs', () => {
        for (let round = 0; round < 2; round++) {
          for (let i = 0; i < 2500; i++) {
            assert.strictEqual(helper(`name-${i}`), `${prefix}:name-${i}`)
          }
        }
        assert.strictEqual(helper('orders'), `${prefix}:orders`)
      })
    })
  }
})
