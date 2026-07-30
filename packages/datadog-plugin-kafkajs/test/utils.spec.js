'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { convertToTextMap, getKafkaMessageSize } = require('../src/utils')

describe('convertToTextMap', () => {
  it('converts scalar string and Buffer values', () => {
    assert.deepStrictEqual(convertToTextMap({
      text: 'value',
      binary: Buffer.from('buffer'),
    }), {
      text: 'value',
      binary: 'buffer',
    })
  })

  it('keeps duplicate traceparent values as an array instead of selecting a context', () => {
    assert.deepStrictEqual(convertToTextMap({
      traceparent: [Buffer.from('first'), Buffer.from('second'), Buffer.from('third')],
    }), {
      traceparent: ['first', 'second', 'third'],
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

  it('preserves a nullish final KafkaJS header value', () => {
    assert.deepStrictEqual(convertToTextMap({
      traceparent: [Buffer.from('current'), undefined],
    }), {
      traceparent: ['current', undefined],
    })
  })

  it('preserves nullish scalar values', () => {
    assert.deepStrictEqual(convertToTextMap({
      first: null,
      second: undefined,
    }), {
      first: null,
      second: undefined,
    })
  })

  it('preserves repeated native-list values', () => {
    assert.deepStrictEqual(convertToTextMap([
      { traceparent: Buffer.from('stale') },
      { traceparent: Buffer.from('current') },
    ]), {
      traceparent: ['stale', 'current'],
    })
  })

  it('preserves nullish native-list values', () => {
    assert.deepStrictEqual(convertToTextMap([
      { first: null },
      { second: undefined },
    ]), {
      first: null,
      second: undefined,
    })
  })

  it('preserves a nullish final native-list value', () => {
    assert.deepStrictEqual(convertToTextMap([
      { traceparent: Buffer.from('current') },
      { traceparent: undefined },
    ]), {
      traceparent: ['current', undefined],
    })
  })

  it('preserves repeated baggage and tracestate members', () => {
    assert.deepStrictEqual(convertToTextMap({
      baggage: [Buffer.from('first=one'), Buffer.from('second=two')],
      tracestate: [Buffer.from('vendor=one'), Buffer.from('other=two')],
    }), {
      baggage: ['first=one', 'second=two'],
      tracestate: ['vendor=one', 'other=two'],
    })
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
