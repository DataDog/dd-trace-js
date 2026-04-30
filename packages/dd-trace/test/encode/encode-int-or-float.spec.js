'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const msgpack = require('@msgpack/msgpack')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const id = require('../../src/id')

// `pinkey` is the `metrics` map key the test pins. Its 7-byte fixstr
// encoding (fixstr-6 prefix + ASCII) is unique within the encoded payload,
// so the byte that immediately follows the marker is the value's prefix
// byte emitted by `_encodeIntOrFloat`.
const PIN_KEY = 'pinkey'
const PIN_KEY_BYTES = Buffer.from([0xA6, 0x70, 0x69, 0x6E, 0x6B, 0x65, 0x79])

const cases = [
  { label: '0 as positive fixint', value: 0, prefix: 0x00, expected: 0 },
  { label: '1 as positive fixint', value: 1, prefix: 0x01, expected: 1 },
  { label: '127 as positive fixint upper boundary', value: 127, prefix: 0x7F, expected: 127 },
  { label: '128 as uint8', value: 128, prefix: 0xCC, expected: 128 },
  { label: '255 as uint8 upper boundary', value: 255, prefix: 0xCC, expected: 255 },
  { label: '256 as uint16', value: 256, prefix: 0xCD, expected: 256 },
  { label: '0xFFFF as uint16 upper boundary', value: 0xFFFF, prefix: 0xCD, expected: 0xFFFF },
  { label: '0x10000 as uint32', value: 0x10000, prefix: 0xCE, expected: 0x10000 },
  // -1 lands in negative fixint (-32..-1, single byte 0xE0..0xFF), not int8.
  // The single byte IS the encoding; -1 cast to a byte reads back as 0xFF.
  { label: '-1 as negative fixint', value: -1, prefix: 0xFF, expected: -1 },
  {
    label: 'Number.MAX_SAFE_INTEGER as uint64',
    value: Number.MAX_SAFE_INTEGER,
    prefix: 0xCF,
    expected: BigInt(Number.MAX_SAFE_INTEGER),
  },
  // `MsgpackEncoder.encodeNumber` would coerce NaN to fixint 0 — `_encodeIntOrFloat`
  // keeps it as float64 so the agent sees what the application produced.
  { label: 'NaN as float64 (not coerced to fixint 0)', value: Number.NaN, prefix: 0xCB, expectedNaN: true },
  { label: 'Infinity as float64', value: Number.POSITIVE_INFINITY, prefix: 0xCB, expected: Number.POSITIVE_INFINITY },
  { label: '-Infinity as float64', value: Number.NEGATIVE_INFINITY, prefix: 0xCB, expected: Number.NEGATIVE_INFINITY },
  { label: '1.5 as float64', value: 1.5, prefix: 0xCB, expected: 1.5 },
  // -0 takes the fixint fast path: `(-0 & 0x7F)` is 0 and `-0 === 0` in JS,
  // so the encoder writes a single 0x00 byte and the wire carries +0.
  { label: '-0 collapses to positive fixint zero', value: -0, prefix: 0x00, expected: 0 },
]

describe('encode 0.4 _encodeIntOrFloat', () => {
  let encoder

  beforeEach(() => {
    const getConfig = () => ({ trace: { nativeSpanEvents: false } })
    const { AgentEncoder } = proxyquire('../../src/encode/0.4', {
      '../log': { debug: sinon.stub() },
      '../config': getConfig,
    })
    encoder = new AgentEncoder({ flush: sinon.spy() })
  })

  /**
   * Encode a span with `metrics.pinkey === value`, then locate the value's
   * prefix byte and decode the round-trip value.
   *
   * @param {number} value
   * @returns {{ prefix: number, decoded: number | bigint }}
   */
  function encodePinned (value) {
    encoder.encode([{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      name: 'test',
      resource: 'test-r',
      service: 'test-s',
      error: 0,
      meta: { bar: 'baz' },
      metrics: { [PIN_KEY]: value },
      start: 123,
      duration: 456,
    }])

    const payload = encoder.makePayload()
    const markerOffset = payload.indexOf(PIN_KEY_BYTES)
    assert.notStrictEqual(markerOffset, -1, 'pinkey marker not found in payload')

    const prefix = payload[markerOffset + PIN_KEY_BYTES.length]
    const decoded = msgpack.decode(payload, { useBigInt64: true })[0][0].metrics[PIN_KEY]

    return { prefix, decoded }
  }

  for (const testCase of cases) {
    it(`encodes ${testCase.label}`, () => {
      const { prefix, decoded } = encodePinned(testCase.value)
      assert.strictEqual(prefix, testCase.prefix)
      if (testCase.expectedNaN) {
        assert.ok(Number.isNaN(decoded), `expected NaN, got ${decoded}`)
      } else {
        assert.strictEqual(decoded, testCase.expected)
      }
    })
  }
})
