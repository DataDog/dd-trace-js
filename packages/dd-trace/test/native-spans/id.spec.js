'use strict'

require('../setup/core')

const assert = require('node:assert/strict')

const { NativeId, ZERO_ID, randomId, traceIdFrom } = require('../../src/native-spans/id')

describe('native-spans id', () => {
  describe('lanes', () => {
    it('exposes the lanes it was built from', () => {
      const id = new NativeId(0x1234_5678, 0x9ABC_DEF0)

      assert.strictEqual(id.hi, 0x1234_5678)
      assert.strictEqual(id.lo, 0x9ABC_DEF0)
      assert.strictEqual(id.upperHi, 0)
      assert.strictEqual(id.upperLo, 0)
    })
  })

  describe('toString', () => {
    it('renders a 64-bit id as 16 hex characters, zero-padded', () => {
      assert.strictEqual(new NativeId(0, 1).toString(16), '0000000000000001')
      assert.strictEqual(new NativeId(0xFF, 0xFF).toString(16), '000000ff000000ff')
    })

    it('renders a 128-bit id as 32 hex characters', () => {
      const id = new NativeId(0x3333_3333, 0x4444_4444, 0x1111_1111, 0x2222_2222)

      assert.strictEqual(id.toString(16), '11111111222222223333333344444444')
    })

    it('renders decimal from the low 64 bits', () => {
      assert.strictEqual(new NativeId(1, 0).toString(10), '4294967296')
      assert.strictEqual(new NativeId(0xFFFF_FFFF, 0xFFFF_FFFF).toString(10), '18446744073709551615')
    })

    it('caches both forms', () => {
      const id = new NativeId(1, 2)

      assert.strictEqual(id.toString(16), id.toString(16))
      assert.strictEqual(id.toString(10), id.toString(10))
    })

    it('serializes to hex through toJSON', () => {
      assert.strictEqual(new NativeId(0, 255).toJSON(), '00000000000000ff')
    })
  })

  describe('toBigInt', () => {
    it('combines the low lanes', () => {
      assert.strictEqual(new NativeId(1, 2).toBigInt(), (1n << 32n) | 2n)
    })

    it('reaches the full unsigned 64-bit range', () => {
      assert.strictEqual(new NativeId(0xFFFF_FFFF, 0xFFFF_FFFF).toBigInt(), 18_446_744_073_709_551_615n)
    })
  })

  describe('toBuffer', () => {
    it('writes the low 64 bits big-endian, matching id.js', () => {
      const bytes = new NativeId(0x0102_0304, 0x0506_0708).toBuffer()

      assert.deepStrictEqual([...bytes], [1, 2, 3, 4, 5, 6, 7, 8])
    })

    it('is always eight bytes, even for a 128-bit id', () => {
      const id = new NativeId(0, 1, 0xAAAA_AAAA, 0xBBBB_BBBB)

      assert.strictEqual(id.toBuffer().length, 8)
      assert.deepStrictEqual([...id.toBuffer()], [0, 0, 0, 0, 0, 0, 0, 1])
    })

    it('returns the same buffer through toArray', () => {
      const id = new NativeId(1, 2)

      assert.strictEqual(id.toArray(), id.toBuffer())
    })
  })

  describe('toTraceIdHex', () => {
    it('prepends the high half when this id carries none', () => {
      const id = new NativeId(0, 1)

      assert.strictEqual(id.toTraceIdHex('aaaaaaaaaaaaaaaa'), 'aaaaaaaaaaaaaaaa0000000000000001')
    })

    it('ignores the argument when the id already carries its high half', () => {
      const id = new NativeId(0, 1, 0xAAAA_AAAA, 0xAAAA_AAAA)

      assert.strictEqual(id.toTraceIdHex('bbbbbbbbbbbbbbbb'), 'aaaaaaaaaaaaaaaa0000000000000001')
    })
  })

  describe('equals', () => {
    it('compares the low 64 bits', () => {
      assert.ok(new NativeId(1, 2).equals(new NativeId(1, 2)))
      assert.ok(!new NativeId(1, 2).equals(new NativeId(1, 3)))
      assert.ok(!new NativeId(1, 2).equals(new NativeId(2, 2)))
    })

    it('ignores the high half, like id.js\'s suffix compare', () => {
      assert.ok(new NativeId(1, 2, 9, 9).equals(new NativeId(1, 2)))
    })
  })

  describe('randomId', () => {
    it('stays a positive int64', () => {
      for (let index = 0; index < 100; index++) {
        assert.ok(randomId().hi <= 0x7FFF_FFFF, 'the sign bit must stay clear')
      }
    })

    it('does not repeat across a batch refill', () => {
      // The pool holds 8192 ids; crossing it exercises the refill path.
      const seen = new Set()
      for (let index = 0; index < 9000; index++) {
        seen.add(randomId().toString(16))
      }

      assert.strictEqual(seen.size, 9000)
    })
  })

  describe('traceIdFrom', () => {
    it('puts the root span id in the low half and the start second in the high', () => {
      const rootSpanId = new NativeId(0x1111_1111, 0x2222_2222)
      const traceId = traceIdFrom(rootSpanId, 1_786_060_800_000)

      assert.strictEqual(traceId.hi, 0x1111_1111)
      assert.strictEqual(traceId.lo, 0x2222_2222)
      assert.strictEqual(traceId.upperHi, 1_786_060_800)
      assert.strictEqual(traceId.upperLo, 0)
    })

    it('matches the hex shape span.js writes as _dd.p.tid', () => {
      const traceId = traceIdFrom(new NativeId(0, 1), 1_786_060_800_000)
      const expected = Math.floor(1_786_060_800_000 / 1000).toString(16).padStart(8, '0').padEnd(16, '0')

      assert.strictEqual(traceId.toString(16).slice(0, 16), expected)
    })
  })

  describe('ZERO_ID', () => {
    it('is the all-zero id every absent parent points at', () => {
      assert.strictEqual(ZERO_ID.hi, 0)
      assert.strictEqual(ZERO_ID.lo, 0)
      assert.strictEqual(ZERO_ID.toString(10), '0')
    })
  })
})
