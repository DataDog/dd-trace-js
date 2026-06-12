'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
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
      },
    }

    sinon.stub(Math, 'random')

    id = proxyquire('../src/id', {
      crypto,
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

  it('should return the ID as BigInt', () => {
    const ids = [
      ['13835058055282163712', 13835058055282163712n],
      ['10', 10n],
      ['9007199254740991', 9007199254740991n],
    ]

    for (const [tid, expected] of ids) {
      const spanId = id(tid, 10)

      assert.strictEqual(spanId.toBigInt(), expected)
    }
  })

  it('should return the same BigInt value across repeated toBigInt calls', () => {
    const samples = [
      id('abcd', 16),
      id('12293a8527e70a7f27c8d624ace0f559', 16),
      id('1234', 10),
      id('0', 16),
    ]

    for (const spanId of samples) {
      const first = spanId.toBigInt()
      assert.strictEqual(spanId.toBigInt(), first)
      assert.strictEqual(spanId.toBigInt(), first)
    }
  })

  it('should match Buffer#readBigUInt64BE on the underlying buffer', () => {
    const cases = ['abcd', '12293a8527e70a7f27c8d624ace0f559', '7f00ff00ff00ff00']

    for (const hex of cases) {
      const spanId = id(hex, 16)
      const expected = Buffer.from(spanId.toBuffer()).readBigUInt64BE(0)

      assert.strictEqual(spanId.toBigInt(), expected)
    }
  })

  it('should return the same string across repeated toString calls for radix 16 and radix 10', () => {
    const samples = [
      id('abcd', 16),
      id('12293a8527e70a7f27c8d624ace0f559', 16),
      id('1234', 10),
      id('0', 16),
    ]

    for (const spanId of samples) {
      const hex = spanId.toString(16)
      assert.strictEqual(spanId.toString(16), hex)
      assert.strictEqual(spanId.toString(), hex)
      assert.strictEqual(spanId.toJSON(), hex)

      const decimal = spanId.toString(10)
      assert.strictEqual(spanId.toString(10), decimal)
    }
  })

  it('should still recompute toString for other radices and not pollute the hex/decimal caches', () => {
    const spanId = id('abcd', 16)

    assert.strictEqual(spanId.toString(8), '125715')
    assert.strictEqual(spanId.toString(8), '125715')
    assert.strictEqual(spanId.toString(2), '1010101111001101')

    assert.strictEqual(spanId.toString(16), '000000000000abcd')
    assert.strictEqual(spanId.toString(10), '43981')
  })
})

describe('id reseed (MicroVM snapshot restore)', () => {
  const BATCH_BYTES = 8 * 8192
  let id
  let randomFillSync
  let kernelReads
  let nextByte

  // Distinct big-endian counter per 8-byte slot: keeps generated ids unique and
  // their sign bit clear (counter << 2^56), so tests can assert distinctness.
  function fillCounter (buffer, base, length) {
    for (let slot = 0; slot < length; slot += 8) {
      let value = nextByte++
      for (let byteIndex = 7; byteIndex >= 0; byteIndex--) {
        buffer[base + slot + byteIndex] = value & 0xFF
        value = Math.floor(value / 256)
      }
    }
  }

  function loadId ({ openThrows = false } = {}) {
    kernelReads = []
    nextByte = 1

    const fs = {
      openSync () {
        if (openThrows) throw new Error('ENOENT: no /dev/urandom')
        return 7
      },
      readSync (fd, buffer, offset, length) {
        kernelReads.push(length)
        fillCounter(buffer, offset, length)
        return length
      },
    }

    randomFillSync = sinon.spy(buffer => fillCounter(buffer, 0, buffer.length))

    return proxyquire('../src/id', { fs, crypto: { randomFillSync } })
  }

  beforeEach(() => {
    id = loadId()
  })

  it('uses the OpenSSL batch fill until reseed runs', () => {
    id()
    id()

    assert.strictEqual(randomFillSync.callCount, 1)
    assert.deepStrictEqual(kernelReads, [])
  })

  it('draws the first post-reseed id from one batched kernel read', () => {
    id()
    const fillsBeforeReseed = randomFillSync.callCount

    id.reseed()
    id()

    assert.deepStrictEqual(kernelReads, [BATCH_BYTES])
    assert.strictEqual(randomFillSync.callCount, fillsBeforeReseed)

    for (let i = 0; i < 100; i++) id()

    assert.deepStrictEqual(kernelReads, [BATCH_BYTES])
  })

  it('reseeds only once: a later reseed does not re-read the kernel', () => {
    id.reseed()
    id()
    id.reseed()
    id()

    assert.deepStrictEqual(kernelReads, [BATCH_BYTES])
  })

  it('refills from the kernel when the batch wraps at 8192', () => {
    id.reseed()

    for (let i = 0; i < 8192; i++) id()
    assert.deepStrictEqual(kernelReads, [BATCH_BYTES])

    id()
    assert.deepStrictEqual(kernelReads, [BATCH_BYTES, BATCH_BYTES])
  })

  it('generates unique positive 63-bit ids from the kernel', () => {
    id.reseed()
    const seen = new Set()

    for (let i = 0; i < 50; i++) {
      const hex = id().toString()
      assert.strictEqual(hex.length, 16)
      assert.strictEqual(Number.parseInt(hex.slice(0, 2), 16) & 0x80, 0)
      seen.add(hex)
    }

    assert.strictEqual(seen.size, 50)
  })

  it('falls back to randomFillSync when /dev/urandom cannot be opened', () => {
    id = loadId({ openThrows: true })

    id.reseed()
    id()

    assert.deepStrictEqual(kernelReads, [])
    assert.ok(randomFillSync.callCount >= 1)
  })
})
