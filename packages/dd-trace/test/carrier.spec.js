'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('./setup/core')
const {
  deleteDatadogParentId,
  dsmBase64NameLength,
  hasDsmBase64,
  pickDsm,
  pickTextMap,
  readDatadogParentId,
  readDatadogTraceId,
  readDsmBase64,
  readDsmBinary,
  readLegacyBaggage,
  readTraceparent,
  readTracestate,
  writeDatadogParentId,
  writeDsmBase64,
  writeLegacyBaggage,
} = require('../src/carrier')

describe('carrier fields', () => {
  describe('list-valued fields', () => {
    const reads = [
      ['passes a scalar string through untouched', 'a=1', 'a=1'],
      ['reports an absent field as undefined', undefined, undefined],
      ['reports a non-string scalar as undefined', 42, undefined],
      ['combines a repeated field with commas in wire order', ['a=1', 'b=2'], 'a=1,b=2'],
      ['unwraps a single-member repeat without adding a comma', ['a=1'], 'a=1'],
      ['reports an empty repeat as the empty string', [], ''],
      ['skips a non-string member instead of coercing it', ['a=1', Symbol('b'), 'c=3'], 'a=1,c=3'],
      ['keeps an empty member as an empty list element', ['', 'a=1'], ',a=1'],
      ['reports a repeat of only non-string members as the empty string', [42, null], ''],
    ]

    for (const [name, value, expected] of reads) {
      it(name, () => {
        assert.strictEqual(readTracestate({ tracestate: value }), expected)
      })
    }
  })

  describe('last-valued text fields', () => {
    const reads = [
      ['passes a scalar string through untouched', '123', '123'],
      ['reports an absent field as undefined', undefined, undefined],
      ['rejects a non-string scalar', 42, undefined],
      ['resolves a repeated field to the last string', ['123', '456'], '456'],
      ['unwraps a single-member repeat', ['123'], '123'],
      ['reports an empty repeat as undefined', [], undefined],
      ['skips a trailing non-string member instead of coercing it', ['123', Symbol('x')], '123'],
      ['reports a repeat of only non-string members as undefined', [42, null], undefined],
    ]

    for (const [name, value, expected] of reads) {
      it(name, () => {
        assert.strictEqual(readDatadogTraceId({ 'x-datadog-trace-id': value }), expected)
      })
    }

    it('exports read, write, and deletion through named functions', () => {
      const carrier = {}

      writeDatadogParentId(carrier, '123')
      assert.strictEqual(readDatadogParentId(carrier), '123')
      assert.deepStrictEqual(carrier, { 'x-datadog-parent-id': '123' })

      deleteDatadogParentId(carrier)
      assert.strictEqual(readDatadogParentId(carrier), undefined)
      assert.deepStrictEqual(carrier, {})
    })
  })

  describe('traceparent', () => {
    it('accepts a scalar or one field value', () => {
      assert.strictEqual(readTraceparent({ traceparent: 'first' }), 'first')
      assert.strictEqual(readTraceparent({ traceparent: ['first'] }), 'first')
    })

    it('rejects repeated field values', () => {
      assert.strictEqual(readTraceparent({ traceparent: ['first', 'second'] }), undefined)
    })

    it('rejects non-string field values', () => {
      assert.strictEqual(readTraceparent({ traceparent: 42 }), undefined)
      assert.strictEqual(readTraceparent({ traceparent: [42] }), undefined)
    })
  })

  describe('DSM fields', () => {
    it('accepts string and Buffer pathway representations', () => {
      const buffer = Buffer.from('pathway')

      assert.strictEqual(readDsmBase64({ 'dd-pathway-ctx-base64': 'encoded' }), 'encoded')
      assert.strictEqual(readDsmBinary({ 'dd-pathway-ctx': buffer }), buffer)
    })

    it('resolves a repeated pathway field to its last supported value', () => {
      const buffer = Buffer.from('pathway')

      assert.strictEqual(readDsmBinary({ 'dd-pathway-ctx': ['encoded', buffer] }), buffer)
    })

    it('rejects unsupported scalar and repeated pathway values', () => {
      assert.strictEqual(readDsmBinary({ 'dd-pathway-ctx': 42 }), undefined)
      assert.strictEqual(readDsmBinary({ 'dd-pathway-ctx': [42, null] }), undefined)
    })

    it('exports DSM operations without exposing the field name', () => {
      const carrier = {}

      assert.strictEqual(hasDsmBase64(carrier), false)
      writeDsmBase64(carrier, 'encoded')
      assert.strictEqual(hasDsmBase64(carrier), true)
      assert.strictEqual(dsmBase64NameLength, 'dd-pathway-ctx-base64'.length)
    })
  })

  describe('legacy baggage', () => {
    it('validates the derived HTTP field name before allocating a carrier', () => {
      assert.strictEqual(writeLegacyBaggage(undefined, 'not valid', 'value'), undefined)
    })

    it('writes valid fields and returns the carrier', () => {
      const carrier = writeLegacyBaggage(undefined, 'foo', 'bar')

      assert.deepStrictEqual(carrier, { 'ot-baggage-foo': 'bar' })
      assert.strictEqual(writeLegacyBaggage(carrier, 'second', 'value'), carrier)
      assert.deepStrictEqual(carrier, {
        'ot-baggage-foo': 'bar',
        'ot-baggage-second': 'value',
      })
    })

    it('extracts valid string values without exposing the prefix', () => {
      const baggageItems = {}

      readLegacyBaggage({
        'ot-baggage-foo': ['stale', 'current'],
        'ot-baggage-number': 42,
        'ot-baggage-': 'ignored',
      }, baggageItems)

      assert.deepStrictEqual(baggageItems, { foo: 'current' })
    })
  })

  describe('logging views', () => {
    it('selects only text-map propagation fields', () => {
      const carrier = {
        'x-datadog-trace-id': '123',
        traceparent: 'parent',
        baggage: 'foo=bar',
        unrelated: 'value',
      }

      assert.deepStrictEqual(pickTextMap(carrier), {
        'x-datadog-trace-id': '123',
        traceparent: 'parent',
      })
    })

    it('selects both DSM representations', () => {
      const carrier = {
        'dd-pathway-ctx': Buffer.from('pathway'),
        'dd-pathway-ctx-base64': 'encoded',
        unrelated: 'value',
      }

      assert.deepStrictEqual(pickDsm(carrier), {
        'dd-pathway-ctx': carrier['dd-pathway-ctx'],
        'dd-pathway-ctx-base64': 'encoded',
      })
    })
  })
})
