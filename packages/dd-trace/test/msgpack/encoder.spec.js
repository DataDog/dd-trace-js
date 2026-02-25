'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const msgpack = require('@msgpack/msgpack')

require('../setup/core')
const { MsgpackEncoder } = require('../../src/msgpack/encoder')

function randString (length) {
  return Array.from({ length }, () => {
    return String.fromCharCode(Math.floor(Math.random() * 256))
  }).join('')
}

describe('msgpack/encoder', () => {
  let encoder

  beforeEach(() => {
    encoder = new MsgpackEncoder()
  })

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

    const buffer = encoder.encode(data)
    const decoded = msgpack.decode(buffer, { useBigInt64: true })

    assert.ok(Array.isArray(decoded))
    assert.ok(typeof decoded[0] === 'object' && decoded[0] !== null)
    assert.strictEqual(decoded[0].first, 'test')
    assert.ok(typeof decoded[1] === 'object' && decoded[1] !== null)
    assert.strictEqual(decoded[1].fixstr, 'foo')
    assert.ok(Object.hasOwn(decoded[1], 'str'))
    assert.strictEqual(decoded[1].str.length, 1000)
    assert.strictEqual(decoded[1].fixuint, 127)
    assert.strictEqual(decoded[1].fixint, -31)
    assert.strictEqual(decoded[1].uint8, 255)
    assert.strictEqual(decoded[1].uint16, 65535)
    assert.strictEqual(decoded[1].uint32, 4294967295)
    assert.ok(Object.hasOwn(decoded[1], 'uint53'))
    assert.strictEqual(decoded[1].uint53.toString(), '9007199254740991')
    assert.strictEqual(decoded[1].int8, -15)
    assert.strictEqual(decoded[1].int16, -32767)
    assert.strictEqual(decoded[1].int32, -2147483647)
    assert.ok(Object.hasOwn(decoded[1], 'int53'))
    assert.strictEqual(decoded[1].int53.toString(), '-9007199254740991')
    assert.strictEqual(decoded[1].float, 12345.6789)
    assert.ok(Object.hasOwn(decoded[1], 'biguint'))
    assert.strictEqual(decoded[1].biguint.toString(), '9223372036854775807')
    assert.ok(Object.hasOwn(decoded[1], 'bigint'))
    assert.strictEqual(decoded[1].bigint.toString(), '-9223372036854775807')
    assert.ok(Object.hasOwn(decoded[1], 'buffer'))
    assert.strictEqual(decoded[1].buffer.toString('utf8'), 'test')
    assert.ok(Object.hasOwn(decoded[1], 'buffer'))
    assert.strictEqual(decoded[1].buffer.toString('utf8'), 'test')
    assert.ok(Object.hasOwn(decoded[1], 'uint8array'))
    assert.strictEqual(decoded[1].uint8array[0], 1)
    assert.strictEqual(decoded[1].uint8array[1], 2)
    assert.strictEqual(decoded[1].uint8array[2], 3)
    assert.strictEqual(decoded[1].uint8array[3], 4)
  })
})
