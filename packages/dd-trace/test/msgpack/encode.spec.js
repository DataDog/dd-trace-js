'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it } = require('mocha')
const msgpack = require('@msgpack/msgpack')

require('../setup/core')
const { encode } = require('../../src/msgpack')

function randString (length) {
  return Array.from({ length }, () => {
    return String.fromCharCode(Math.floor(Math.random() * 256))
  }).join('')
}

describe('msgpack/encode', () => {
  it('should encode to msgpack', () => {
    const data = [
      { first: 'test' },
      {
        fixstr: 'foo',
        str: randString(1000),
        fixuint: 127,
        fixint: -31,
        uint8: 255,
        uint16: 65535,
        uint32: 4294967295,
        uint53: 9007199254740991,
        int8: -15,
        int16: -32767,
        int32: -2147483647,
        int53: -9007199254740991,
        float: 12345.6789,
        biguint: BigInt('9223372036854775807'),
        bigint: BigInt('-9223372036854775807'),
        buffer: Buffer.from('test'),
        uint8array: new Uint8Array([1, 2, 3, 4]),
      },
    ]

    const buffer = encode(data)
    const decoded = msgpack.decode(buffer, { useBigInt64: true })

    assert.ok(Array.isArray(decoded), `Expected array, got ${inspect(decoded)}`)
    assert.ok(
      typeof decoded[0] === 'object' && decoded[0] !== null,
      `Expected non-null object, got ${inspect(decoded[0])}`
    )
    assert.strictEqual(decoded[0].first, 'test')
    assert.ok(
      typeof decoded[1] === 'object' && decoded[1] !== null,
      `Expected non-null object, got ${inspect(decoded[1])}`
    )
    assert.strictEqual(decoded[1].fixstr, 'foo')
    assert.ok(Object.hasOwn(decoded[1], 'str'), `Available keys: ${inspect(Object.keys(decoded[1]))}`)
    assert.strictEqual(decoded[1].str.length, 1000)
    assert.strictEqual(decoded[1].fixuint, 127)
    assert.strictEqual(decoded[1].fixint, -31)
    assert.strictEqual(decoded[1].uint8, 255)
    assert.strictEqual(decoded[1].uint16, 65535)
    assert.strictEqual(decoded[1].uint32, 4294967295)
    assert.ok(Object.hasOwn(decoded[1], 'uint53'), `Available keys: ${inspect(Object.keys(decoded[1]))}`)
    assert.strictEqual(decoded[1].uint53.toString(), '9007199254740991')
    assert.strictEqual(decoded[1].int8, -15)
    assert.strictEqual(decoded[1].int16, -32767)
    assert.strictEqual(decoded[1].int32, -2147483647)
    assert.ok(Object.hasOwn(decoded[1], 'int53'), `Available keys: ${inspect(Object.keys(decoded[1]))}`)
    assert.strictEqual(decoded[1].int53.toString(), '-9007199254740991')
    assert.strictEqual(decoded[1].float, 12345.6789)
    assert.ok(Object.hasOwn(decoded[1], 'biguint'), `Available keys: ${inspect(Object.keys(decoded[1]))}`)
    assert.strictEqual(decoded[1].biguint.toString(), '9223372036854775807')
    assert.ok(Object.hasOwn(decoded[1], 'bigint'), `Available keys: ${inspect(Object.keys(decoded[1]))}`)
    assert.strictEqual(decoded[1].bigint.toString(), '-9223372036854775807')
    assert.ok(Object.hasOwn(decoded[1], 'buffer'), `Available keys: ${inspect(Object.keys(decoded[1]))}`)
    assert.strictEqual(decoded[1].buffer.toString('utf8'), 'test')
    assert.ok(Object.hasOwn(decoded[1], 'buffer'), `Available keys: ${inspect(Object.keys(decoded[1]))}`)
    assert.strictEqual(decoded[1].buffer.toString('utf8'), 'test')
    assert.ok(Object.hasOwn(decoded[1], 'uint8array'), `Available keys: ${inspect(Object.keys(decoded[1]))}`)
    assert.strictEqual(decoded[1].uint8array[0], 1)
    assert.strictEqual(decoded[1].uint8array[1], 2)
    assert.strictEqual(decoded[1].uint8array[2], 3)
    assert.strictEqual(decoded[1].uint8array[3], 4)
  })

  it('emits 0xC0 for explicit null values', () => {
    const buffer = encode({ value: null })

    assert.deepStrictEqual(msgpack.decode(buffer), { value: null })
  })

  it('emits explicit msgpack booleans', () => {
    const buffer = encode({ yes: true, no: false })

    assert.deepStrictEqual(msgpack.decode(buffer), { yes: true, no: false })
  })

  it('encodes symbols as their `.toString()` representation', () => {
    // `DataStreamsWriter` ships pipeline-stat shapes the caller decides at
    // runtime, so the dispatcher accepts anything `typeof` can name. Symbols
    // collapse to their string form so the agent receives a stable label
    // instead of an opaque payload — and so the encoder never throws when a
    // caller drops a `Symbol` into a stats blob.
    const buffer = encode(Symbol('pipeline'))

    assert.strictEqual(msgpack.decode(buffer), 'Symbol(pipeline)')
  })

  it('falls back to msgpack null for unsupported value types (functions, undefined)', () => {
    // `typeof undefined === 'undefined'` and `typeof () => {} === 'function'`
    // both hit the dispatcher's `default` arm. Encoding them as `nil` keeps
    // the surrounding payload well-formed instead of letting the chunk
    // emit zero bytes for the value, which would desync the map header
    // count from the actual entries.
    const buffer = encode({ fn: () => {}, missing: undefined })

    assert.deepStrictEqual(msgpack.decode(buffer), { fn: null, missing: null })
  })

  it('emits an array32 header for arrays with 16 or more entries', () => {
    const value = Array.from({ length: 16 }, (_, index) => index)

    const buffer = encode(value)

    assert.equal(buffer[0], 0xDD)
    assert.equal(buffer.readUInt32BE(1), 16)
    assert.deepStrictEqual(msgpack.decode(buffer), value)
  })
})
