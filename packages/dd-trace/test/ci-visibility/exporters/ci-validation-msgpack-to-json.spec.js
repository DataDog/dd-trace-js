'use strict'

const assert = require('node:assert/strict')

const msgpack = require('@msgpack/msgpack')

const {
  MAX_COLLECTION_ENTRIES,
  MAX_NESTING_DEPTH,
  MAX_STRING_BYTES,
  msgpackToJson,
} = require('../../../src/ci-visibility/exporters/ci-validation/msgpack-to-json')

describe('CI validation MessagePack-to-JSON converter', () => {
  it('converts supported MessagePack values to JSON without a runtime dependency', () => {
    const input = Buffer.from(msgpack.encode({
      array: [null, true, false, 1.5],
      binary: Buffer.from('payload'),
      text: 'value',
    }))

    assert.deepStrictEqual(JSON.parse(msgpackToJson(input)), {
      array: [null, true, false, 1.5],
      binary: Buffer.from('payload').toString('base64'),
      text: 'value',
    })
  })

  it('preserves unsigned and signed 64-bit values as unquoted JSON numbers', () => {
    const input = Buffer.from([
      0x92,
      0xCF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
      0xD3, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ])

    assert.strictEqual(
      msgpackToJson(input).toString(),
      '[18446744073709551615,-9223372036854775808]'
    )
  })

  it('accepts the last nesting depth and rejects the first excessive depth', () => {
    const nested = depth => Buffer.concat([Buffer.alloc(depth, 0x91), Buffer.from([0xC0])])

    msgpackToJson(nested(MAX_NESTING_DEPTH))
    assert.throws(() => msgpackToJson(nested(MAX_NESTING_DEPTH + 1)), /nesting exceeds/)
  })

  it('accepts the last aggregate collection entry and rejects the first excessive entry', () => {
    msgpackToJson(arrayOfNil(MAX_COLLECTION_ENTRIES))
    assert.throws(() => msgpackToJson(arrayOfNil(MAX_COLLECTION_ENTRIES + 1)), /collection length/)
  })

  it('accepts the last bounded string and rejects the first oversized string', () => {
    msgpackToJson(stringOfLength(MAX_STRING_BYTES))
    assert.throws(() => msgpackToJson(stringOfLength(MAX_STRING_BYTES + 1)), /string exceeds/)
  })

  it('rejects malformed, unsupported, non-finite, and trailing values', () => {
    assert.throws(() => msgpackToJson(Buffer.from([0xD9, 0x01])), /Unexpected end/)
    assert.throws(() => msgpackToJson(Buffer.from([0xD4])), /Unsupported MessagePack/)
    assert.throws(() => msgpackToJson(Buffer.from([0xCB, 0x7F, 0xF8, 0, 0, 0, 0, 0, 0])), /non-finite/)
    assert.throws(() => msgpackToJson(Buffer.from([0xC0, 0xC0])), /trailing data/)
  })
})

function arrayOfNil (length) {
  const prefix = Buffer.alloc(5)
  prefix[0] = 0xDD
  prefix.writeUInt32BE(length, 1)
  return Buffer.concat([prefix, Buffer.alloc(length, 0xC0)])
}

function stringOfLength (length) {
  const prefix = Buffer.alloc(5)
  prefix[0] = 0xDB
  prefix.writeUInt32BE(length, 1)
  return Buffer.concat([prefix, Buffer.alloc(length, 0x61)])
}
