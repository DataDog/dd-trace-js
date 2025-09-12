'use strict'

const assert = require('node:assert')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('./setup/core')

describe('id', () => {
  let id
  let crypto

  beforeEach(() => {
    crypto = {
      randomFillSync: data => {
        for (let i = 0; i < data.length; i += 8) {
          data[i] = 0xFF
          data[i + 1] = 0x00
          data[i + 2] = 0xFF
          data[i + 3] = 0x00
          data[i + 4] = 0xFF
          data[i + 5] = 0x00
          data[i + 6] = 0xFF
          data[i + 7] = 0x00
        }
      }
    }

    sinon.stub(Math, 'random')

    id = proxyquire('../src/id', {
      crypto
    })
  })

  afterEach(() => {
    Math.random.restore()
  })

  it('should return a random 63bit ID', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    assert.strictEqual(id().toString(), '7f00ff00ff00ff00')
  })

  it('should be serializable to an integer', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    const spanId = id()

    assert.strictEqual(spanId.toString(10), '9151594822560186112')
  })

  it('should be serializable to JSON', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    const json = JSON.stringify(id())

    assert.strictEqual(json, '"7f00ff00ff00ff00"')
  })

  it('should return false for is128bit() for 64 bit ID', () => {
    const spanId = id()

    assert.strictEqual(spanId.is128bit(), false)
  })

  it('should return true for is128bit() for 128 bit ID', () => {
    const spanId = id('1234567812345678abcdef', 16)

    assert.strictEqual(spanId.is128bit(), true)
  })

  it('should write 64 bits to a buffer with writeToLast64Bits() for 64 bit ID', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    const buffer = Buffer.alloc(16)
    const spanId = id()
    spanId.writeToLast64Bits(buffer, 0)

    assert.deepStrictEqual(buffer, Buffer.from('cf7f00ff00ff00ff0000000000000000', 'hex'))
  })

  it('should write the last 64 bits to a buffer with writeToLast64Bits() for 128 bit ID', () => {
    const buffer = Buffer.alloc(16)
    const spanId = id('1a2b3c4d1a2b3c4d1234567812345678', 16)
    spanId.writeToLast64Bits(buffer, 2)

    assert.deepStrictEqual(buffer, Buffer.from('0000cf12345678123456780000000000', 'hex'))
  })

  it('should support small hex strings', () => {
    const spanId = id('abcd', 16)

    assert.strictEqual(spanId.toString(), '000000000000abcd')
  })

  it('should support large hex strings', () => {
    const spanId = id('12293a8527e70a7f27c8d624ace0f559', 16)

    assert.strictEqual(spanId.toString(), '12293a8527e70a7f27c8d624ace0f559')
    assert.strictEqual(spanId.toString(10), '2866776615828911449')
  })

  it('should use hex strings by default', () => {
    const spanId = id('abcd')

    assert.strictEqual(spanId.toString(), '000000000000abcd')
  })

  it('should support number strings', () => {
    const spanId = id('1234', 10)

    assert.strictEqual(spanId.toString(10), '1234')
  })

  it('should handle negative number strings as signed integers', () => {
    const spanId = id('-123', 10)

    assert.strictEqual(spanId.toString(10), '18446744073709551493')
  })

  it('should not accept non number strings with radix 10', () => {
    assert.throws(
      () => id('1234abcd1234abcd', 10),
      { name: 'SyntaxError' }
    )
  })

  it('should return the ID as BigInt', () => {
    const ids = [
      ['13835058055282163712', 13835058055282163712n],
      ['10', 10n],
      ['9007199254740991', 9007199254740991n]
    ]

    for (const [tid, expected] of ids) {
      const spanId = id(tid, 10)

      assert.strictEqual(spanId.toFirst64BitsBigInt(), expected)
    }
  })
})
