'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const msgpack = require('@msgpack/msgpack')

require('../setup/core')
const MsgpackChunk = require('../../src/msgpack/chunk')

const DEFAULT_MIN_SIZE = 1024 * 1024
const SHRINK_AFTER_FLUSHES = 32

function used (chunk) {
  return chunk.buffer.subarray(0, chunk.length)
}

describe('MsgpackChunk', () => {
  describe('reserve', () => {
    it('keeps the initial capacity until the cursor crosses it', () => {
      const chunk = new MsgpackChunk()

      assert.equal(chunk.buffer.length, DEFAULT_MIN_SIZE)
      chunk.reserve(DEFAULT_MIN_SIZE)
      assert.equal(chunk.buffer.length, DEFAULT_MIN_SIZE)
      assert.equal(chunk.length, DEFAULT_MIN_SIZE)
    })

    it('doubles the buffer when the requested size overflows', () => {
      const chunk = new MsgpackChunk()

      chunk.reserve(DEFAULT_MIN_SIZE + 1)

      assert.equal(chunk.buffer.length, DEFAULT_MIN_SIZE * 2)
      assert.equal(chunk.length, DEFAULT_MIN_SIZE + 1)
    })

    it('doubles repeatedly when a single write blows past several capacities', () => {
      const chunk = new MsgpackChunk()

      chunk.reserve(DEFAULT_MIN_SIZE * 5)

      assert.equal(chunk.buffer.length, DEFAULT_MIN_SIZE * 8)
      assert.equal(chunk.length, DEFAULT_MIN_SIZE * 5)
    })

    it('honours an explicit minSize floor', () => {
      const chunk = new MsgpackChunk(2048)

      assert.equal(chunk.buffer.length, 2048)
      chunk.reserve(2049)
      assert.equal(chunk.buffer.length, 4096)
    })
  })

  describe('reset', () => {
    it('zeros the cursor', () => {
      const chunk = new MsgpackChunk()

      chunk.reserve(1024)
      chunk.reset()

      assert.equal(chunk.length, 0)
    })

    it('does not shrink while the buffer is at minSize', () => {
      const chunk = new MsgpackChunk()
      const buffer = chunk.buffer

      for (let i = 0; i < SHRINK_AFTER_FLUSHES * 2; i++) {
        chunk.reset()
      }

      assert.equal(chunk.buffer, buffer)
    })

    it('halves the buffer after the streak of low-usage flushes', () => {
      const chunk = new MsgpackChunk()

      chunk.reserve(DEFAULT_MIN_SIZE * 4)
      const grown = chunk.buffer
      assert.equal(grown.length, DEFAULT_MIN_SIZE * 4)

      // Drain back to a small payload; subsequent flushes stay tiny.
      chunk.length = 1
      for (let i = 0; i < SHRINK_AFTER_FLUSHES - 1; i++) {
        chunk.reset()
        assert.equal(chunk.buffer, grown, `flush ${i} should not have shrunk yet`)
        chunk.length = 1
      }

      chunk.reset()
      assert.equal(chunk.buffer.length, DEFAULT_MIN_SIZE * 2)
      assert.notEqual(chunk.buffer, grown)
    })

    it('does not shrink below minSize even after many quiet flushes', () => {
      const chunk = new MsgpackChunk()

      chunk.reserve(DEFAULT_MIN_SIZE * 2)
      chunk.length = 0

      for (let i = 0; i < SHRINK_AFTER_FLUSHES * 10; i++) {
        chunk.reset()
      }

      assert.equal(chunk.buffer.length, DEFAULT_MIN_SIZE)
    })

    it('resets the streak when a flush fills above the shrink threshold', () => {
      const chunk = new MsgpackChunk()

      chunk.reserve(DEFAULT_MIN_SIZE * 2)
      const grown = chunk.buffer

      for (let i = 0; i < SHRINK_AFTER_FLUSHES - 1; i++) {
        chunk.length = 1
        chunk.reset()
      }
      // One peak above 1/4 cancels the pending shrink.
      chunk.length = (DEFAULT_MIN_SIZE * 2 / 4) + 1
      chunk.reset()
      assert.equal(chunk.buffer, grown)

      // A new streak must still take SHRINK_AFTER_FLUSHES quiet flushes.
      for (let i = 0; i < SHRINK_AFTER_FLUSHES - 1; i++) {
        chunk.length = 1
        chunk.reset()
        assert.equal(chunk.buffer, grown)
      }
      chunk.length = 1
      chunk.reset()
      assert.equal(chunk.buffer.length, DEFAULT_MIN_SIZE)
    })
  })

  describe('write', () => {
    it('emits a fixstr for strings shorter than 32 UTF-8 bytes', () => {
      const chunk = new MsgpackChunk()

      const written = chunk.write('hello')

      assert.equal(written, 6)
      assert.equal(chunk.length, 6)
      assert.equal(chunk.buffer[0], 0xA5)
      assert.equal(chunk.buffer.subarray(1, 6).toString('utf8'), 'hello')
    })

    it('emits a str32 for strings that overflow fixstr (length >= 32)', () => {
      const chunk = new MsgpackChunk()
      const value = 'a'.repeat(32)

      chunk.write(value)

      assert.equal(chunk.length, 37)
      assert.equal(chunk.buffer[0], 0xDB)
      assert.equal(chunk.buffer.readUInt32BE(1), 32)
      assert.equal(msgpack.decode(used(chunk)), value)
    })

    it('emits an empty fixstr for the empty string', () => {
      const chunk = new MsgpackChunk()

      const written = chunk.write('')

      assert.equal(written, 1)
      assert.equal(chunk.buffer[0], 0xA0)
    })
  })

  describe('copy', () => {
    it('copies the used bytes into the target buffer', () => {
      const chunk = new MsgpackChunk()
      chunk.write('hello')

      const target = Buffer.alloc(6)
      chunk.copy(target, 0, chunk.length)

      assert.deepStrictEqual(target, Buffer.from([0xA5, 0x68, 0x65, 0x6C, 0x6C, 0x6F]))
    })
  })

  describe('with a pool-allocated backing buffer', () => {
    // `Buffer.allocUnsafe(2048)` cycles offsets 0, 2048, 4096, 6144 inside
    // the shared 8 KiB pool. Retry until the chunk lands at a non-zero offset.
    function poolOffsetChunk () {
      for (let attempts = 0; attempts < 8; attempts++) {
        const chunk = new MsgpackChunk(2048)
        if (chunk.buffer.byteOffset !== 0) return chunk
      }
      throw new Error('Buffer.allocUnsafe pool layout unexpected; refresh the test helper')
    }

    it('writeFloat lands in the chunk slice', () => {
      const chunk = poolOffsetChunk()

      chunk.writeFloat(1.5)

      const expected = Buffer.alloc(9)
      expected[0] = 0xCB
      expected.writeDoubleBE(1.5, 1)
      assert.deepStrictEqual(used(chunk), expected)
    })

    it('writeBigInt lands in the chunk slice for positive and negative values', () => {
      const positive = poolOffsetChunk()
      positive.writeBigInt(9_223_372_036_854_775_807n)
      const expectedPos = Buffer.alloc(9)
      expectedPos[0] = 0xCF
      expectedPos.writeBigUInt64BE(9_223_372_036_854_775_807n, 1)
      assert.deepStrictEqual(used(positive), expectedPos)

      const negative = poolOffsetChunk()
      negative.writeBigInt(-9_223_372_036_854_775_807n)
      const expectedNeg = Buffer.alloc(9)
      expectedNeg[0] = 0xD3
      expectedNeg.writeBigInt64BE(-9_223_372_036_854_775_807n, 1)
      assert.deepStrictEqual(used(negative), expectedNeg)
    })

    it('copy returns the chunk slice bytes, not the underlying slab', () => {
      const chunk = poolOffsetChunk()
      chunk.write('hello')

      const target = Buffer.alloc(6)
      chunk.copy(target, 0, chunk.length)

      assert.deepStrictEqual(target, Buffer.from([0xA5, 0x68, 0x65, 0x6C, 0x6C, 0x6F]))
    })
  })

  describe('set', () => {
    it('appends raw bytes and advances the cursor', () => {
      const chunk = new MsgpackChunk()

      chunk.set(Buffer.from([0xC2, 0xC3]))

      assert.equal(chunk.length, 2)
      assert.deepStrictEqual(used(chunk), Buffer.from([0xC2, 0xC3]))
    })
  })

  describe('writeNull', () => {
    it('emits a single 0xC0 byte', () => {
      const chunk = new MsgpackChunk()

      chunk.writeNull()

      assert.equal(chunk.length, 1)
      assert.equal(chunk.buffer[0], 0xC0)
      assert.equal(msgpack.decode(used(chunk)), null)
    })
  })

  describe('writeBoolean', () => {
    it('emits 0xC3 for true and 0xC2 for false', () => {
      const chunk = new MsgpackChunk()

      chunk.writeBoolean(true)
      chunk.writeBoolean(false)

      assert.deepStrictEqual(used(chunk), Buffer.from([0xC3, 0xC2]))
    })
  })

  describe('writeFixArray', () => {
    it('emits 0x90 + size for sizes that fit in fixarray', () => {
      const chunk = new MsgpackChunk()

      chunk.writeFixArray(0)
      chunk.writeFixArray(15)

      assert.deepStrictEqual(used(chunk), Buffer.from([0x90, 0x9F]))
    })
  })

  describe('writeArrayPrefix', () => {
    it('emits an array32 header with the value length', () => {
      const chunk = new MsgpackChunk()

      chunk.writeArrayPrefix({ length: 16 })

      assert.equal(chunk.length, 5)
      assert.equal(chunk.buffer[0], 0xDD)
      assert.equal(chunk.buffer.readUInt32BE(1), 16)
    })
  })

  describe('writeMapPrefix', () => {
    it('emits a map32 header with the entry count', () => {
      const chunk = new MsgpackChunk()

      chunk.writeMapPrefix(42)

      assert.equal(chunk.length, 5)
      assert.equal(chunk.buffer[0], 0xDF)
      assert.equal(chunk.buffer.readUInt32BE(1), 42)
    })
  })

  describe('writeByte', () => {
    it('writes a single raw byte', () => {
      const chunk = new MsgpackChunk()

      chunk.writeByte(0x9C)

      assert.deepStrictEqual(used(chunk), Buffer.from([0x9C]))
    })
  })

  describe('writeBin', () => {
    it('emits a bin8 header for byteLength < 256', () => {
      const chunk = new MsgpackChunk()
      const value = Buffer.from([1, 2, 3])

      chunk.writeBin(value)

      assert.equal(chunk.buffer[0], 0xC4)
      assert.equal(chunk.buffer[1], 3)
      assert.deepStrictEqual(used(chunk).subarray(2), value)
    })

    it('emits a bin16 header for byteLength < 65 536', () => {
      const chunk = new MsgpackChunk()
      const value = Buffer.alloc(256, 0xAB)

      chunk.writeBin(value)

      assert.equal(chunk.buffer[0], 0xC5)
      assert.equal(chunk.buffer.readUInt16BE(1), 256)
      assert.deepStrictEqual(msgpack.decode(used(chunk)), value)
    })

    it('emits a bin32 header for byteLength >= 65 536', () => {
      const chunk = new MsgpackChunk()
      const value = Buffer.alloc(65_536, 0xCD)

      chunk.writeBin(value)

      assert.equal(chunk.buffer[0], 0xC6)
      assert.equal(chunk.buffer.readUInt32BE(1), 65_536)
      assert.deepStrictEqual(msgpack.decode(used(chunk)), value)
    })
  })

  describe('writeInteger', () => {
    it('always emits a uint32 (0xCE + 4 bytes), regardless of magnitude', () => {
      const chunk = new MsgpackChunk()

      chunk.writeInteger(1)

      assert.equal(chunk.length, 5)
      assert.equal(chunk.buffer[0], 0xCE)
      assert.equal(chunk.buffer.readUInt32BE(1), 1)
    })
  })

  describe('writeLong', () => {
    it('emits a uint64 (0xCF + 8 bytes)', () => {
      const chunk = new MsgpackChunk()
      const value = 2 ** 40

      chunk.writeLong(value)

      assert.equal(chunk.buffer[0], 0xCF)
      assert.equal(msgpack.decode(used(chunk), { useBigInt64: true }).toString(), String(value))
    })
  })

  describe('writeUnsigned', () => {
    it('picks the shortest encoding across the magnitude boundaries', () => {
      const cases = [
        [0, [0x00]],
        [127, [0x7F]], // last fixint
        [128, [0xCC, 0x80]], // first uint8
        [255, [0xCC, 0xFF]], // last uint8
        [256, [0xCD, 0x01, 0x00]], // first uint16
        [0xFF_FF, [0xCD, 0xFF, 0xFF]], // last uint16
        [0x1_00_00, [0xCE, 0x00, 0x01, 0x00, 0x00]], // first uint32
        [0xFF_FF_FF_FF, [0xCE, 0xFF, 0xFF, 0xFF, 0xFF]], // last uint32
        [0x1_00_00_00_00, [0xCF, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]], // first uint64
      ]
      for (const [value, expected] of cases) {
        const chunk = new MsgpackChunk()
        chunk.writeUnsigned(value)
        assert.deepStrictEqual(used(chunk), Buffer.from(expected), `writeUnsigned(${value})`)
      }
    })
  })

  describe('writeSigned', () => {
    it('picks the shortest encoding across the magnitude boundaries', () => {
      // -33 lands in int8 — the path AgentEncoder never reaches because
      // span numerics only round-trip through `writeIntOrFloat`'s fixint
      // fast path or `writeFloat`. Test it directly so the int8 branch is
      // pinned.
      const cases = [
        [-1, [0xFF]], // negative fixint (5-bit two's complement)
        [-0x20, [0xE0]], // last negative fixint
        [-0x21, [0xD0, 0xDF]], // first int8 — 0xD0 + 0xDF = -33
        [-0x80, [0xD0, 0x80]], // last int8
        [-0x81, [0xD1, 0xFF, 0x7F]], // first int16
        [-0x80_00, [0xD1, 0x80, 0x00]], // last int16
        [-0x80_01, [0xD2, 0xFF, 0xFF, 0x7F, 0xFF]], // first int32
        [-0x80_00_00_00, [0xD2, 0x80, 0x00, 0x00, 0x00]], // last int32
        [-0x80_00_00_01, [0xD3, 0xFF, 0xFF, 0xFF, 0xFF, 0x7F, 0xFF, 0xFF, 0xFF]], // first int64
      ]
      for (const [value, expected] of cases) {
        const chunk = new MsgpackChunk()
        chunk.writeSigned(value)
        assert.deepStrictEqual(used(chunk), Buffer.from(expected), `writeSigned(${value})`)
      }
    })
  })

  describe('writeBigInt', () => {
    it('emits 0xCF + uint64 for non-negative bigints', () => {
      const chunk = new MsgpackChunk()
      const value = 9_223_372_036_854_775_807n

      chunk.writeBigInt(value)

      assert.equal(chunk.buffer[0], 0xCF)
      assert.equal(msgpack.decode(used(chunk), { useBigInt64: true }), value)
    })

    it('emits 0xD3 + int64 for negative bigints', () => {
      const chunk = new MsgpackChunk()
      const value = -9_223_372_036_854_775_807n

      chunk.writeBigInt(value)

      assert.equal(chunk.buffer[0], 0xD3)
      assert.equal(msgpack.decode(used(chunk), { useBigInt64: true }), value)
    })
  })

  describe('writeFloat', () => {
    it('emits 0xCB + 8-byte float64', () => {
      const chunk = new MsgpackChunk()

      chunk.writeFloat(1.5)

      assert.equal(chunk.length, 9)
      assert.equal(chunk.buffer[0], 0xCB)
      assert.equal(msgpack.decode(used(chunk)), 1.5)
    })
  })

  describe('writeNumber', () => {
    it('collapses NaN to fixint 0 (datastreams writer never reads NaN)', () => {
      const chunk = new MsgpackChunk()

      chunk.writeNumber(Number.NaN)

      assert.deepStrictEqual(used(chunk), Buffer.from([0x00]))
    })

    it('routes integers through the unsigned / signed encoders and floats through writeFloat', () => {
      const cases = [
        [0, [0x00]],
        [-1, [0xFF]],
        [1024, [0xCD, 0x04, 0x00]],
        [-1024, [0xD1, 0xFC, 0x00]],
      ]
      for (const [value, expected] of cases) {
        const chunk = new MsgpackChunk()
        chunk.writeNumber(value)
        assert.deepStrictEqual(used(chunk), Buffer.from(expected), `writeNumber(${value})`)
      }

      const floatChunk = new MsgpackChunk()
      floatChunk.writeNumber(1.5)
      assert.equal(floatChunk.buffer[0], 0xCB)
      assert.equal(msgpack.decode(used(floatChunk)), 1.5)
    })
  })

  describe('writeIntOrFloat', () => {
    it('uses the fixint fast path for 0..127', () => {
      const chunk = new MsgpackChunk()

      chunk.writeIntOrFloat(0)
      chunk.writeIntOrFloat(127)

      assert.deepStrictEqual(used(chunk), Buffer.from([0x00, 0x7F]))
    })

    it('preserves NaN as float64 instead of coercing to 0', () => {
      // The tracer's span numeric path must see exactly the value the
      // application produced; coercing NaN here would drop information that
      // `writeNumber` is explicitly happy to discard.
      const chunk = new MsgpackChunk()

      chunk.writeIntOrFloat(Number.NaN)

      assert.equal(chunk.buffer[0], 0xCB)
      assert.ok(Number.isNaN(msgpack.decode(used(chunk))))
    })

    it('routes magnitudes outside the fast path through the right shortest encoder', () => {
      const cases = [
        [128, [0xCC, 0x80]],
        [-1, [0xFF]],
        [-1024, [0xD1, 0xFC, 0x00]],
        [0xFF_FF_FF_FF, [0xCE, 0xFF, 0xFF, 0xFF, 0xFF]],
      ]
      for (const [value, expected] of cases) {
        const chunk = new MsgpackChunk()
        chunk.writeIntOrFloat(value)
        assert.deepStrictEqual(used(chunk), Buffer.from(expected), `writeIntOrFloat(${value})`)
      }

      const floatChunk = new MsgpackChunk()
      floatChunk.writeIntOrFloat(1.5)
      assert.equal(floatChunk.buffer[0], 0xCB)
      assert.equal(msgpack.decode(used(floatChunk)), 1.5)
    })
  })
})
