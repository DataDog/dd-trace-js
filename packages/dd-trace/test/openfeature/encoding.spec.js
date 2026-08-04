'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

require('../setup/core')

const { encodeVarint, encodeDeltaVarint, hashTargetingKey } = require('../../src/openfeature/encoding')

describe('encoding', () => {
  describe('encodeVarint()', () => {
    it('should encode single-byte values (0-127)', () => {
      assert.deepStrictEqual(encodeVarint(0), [0])
      assert.deepStrictEqual(encodeVarint(1), [1])
      assert.deepStrictEqual(encodeVarint(127), [127])
    })

    it('should encode two-byte values (128-16383)', () => {
      // 128 = 0b10000000 -> [0x80 | 0x00, 0x01] = [0x80, 0x01]
      assert.deepStrictEqual(encodeVarint(128), [0x80, 0x01])
      // 300 = 0b100101100 -> [0xAC, 0x02]
      assert.deepStrictEqual(encodeVarint(300), [0xAC, 0x02])
    })

    it('should encode larger values', () => {
      // 16384 = 0b100000000000000 -> [0x80, 0x80, 0x01]
      assert.deepStrictEqual(encodeVarint(16384), [0x80, 0x80, 0x01])
    })
  })

  describe('encodeDeltaVarint()', () => {
    it('should return empty string for empty array', () => {
      assert.strictEqual(encodeDeltaVarint([]), '')
    })

    it('should return empty string for null/undefined', () => {
      assert.strictEqual(encodeDeltaVarint(null), '')
      assert.strictEqual(encodeDeltaVarint(undefined), '')
    })

    it('should encode a single value', () => {
      const encoded = encodeDeltaVarint([42])
      const decoded = Buffer.from(encoded, 'base64')
      // 42 as varint is just [42]
      assert.deepStrictEqual([...decoded], [42])
    })

    it('should sort values before encoding', () => {
      // [130, 100, 128, 108] should be sorted to [100, 108, 128, 130]
      // Deltas: [100, 8, 20, 2]
      const encoded = encodeDeltaVarint([130, 100, 128, 108])
      const decoded = Buffer.from(encoded, 'base64')
      assert.deepStrictEqual([...decoded], [100, 8, 20, 2])
    })

    it('should encode known values correctly', () => {
      // Test case from system tests:
      // [100, 108, 128, 130] -> deltas [100, 8, 20, 2] -> base64 "ZAgUAg=="
      const encoded = encodeDeltaVarint([100, 108, 128, 130])
      assert.strictEqual(encoded, 'ZAgUAg==')
    })

    it('should handle duplicate values', () => {
      // Duplicates should result in 0 deltas
      const encoded = encodeDeltaVarint([100, 100, 100])
      const decoded = Buffer.from(encoded, 'base64')
      // After sorting and deduplication via Set in actual usage, but encoding handles dupes
      // [100, 100, 100] sorted -> deltas [100, 0, 0]
      assert.deepStrictEqual([...decoded], [100, 0, 0])
    })

    it('should handle values requiring multi-byte varints', () => {
      // 128 requires 2 bytes: [0x80, 0x01]
      // 256 requires 2 bytes: [0x80, 0x02]
      // [128, 256] -> sorted [128, 256] -> deltas [128, 128]
      const encoded = encodeDeltaVarint([128, 256])
      const decoded = Buffer.from(encoded, 'base64')
      // First delta: 128 -> [0x80, 0x01]
      // Second delta: 128 -> [0x80, 0x01]
      assert.deepStrictEqual([...decoded], [0x80, 0x01, 0x80, 0x01])
    })

    it('should encode large deltas correctly', () => {
      // [1, 1000] -> deltas [1, 999]
      // 999 = 0b1111100111 -> [0xE7, 0x07]
      const encoded = encodeDeltaVarint([1, 1000])
      const decoded = Buffer.from(encoded, 'base64')
      assert.deepStrictEqual([...decoded], [1, 0xE7, 0x07])
    })
  })

  describe('hashTargetingKey()', () => {
    it('should return SHA256 hex digest', () => {
      // Known SHA256 hash of "test-user-sha256"
      const hash = hashTargetingKey('test-user-sha256')
      assert.strictEqual(hash.length, 64) // SHA256 produces 64 hex chars
      assert.match(hash, /^[0-9a-f]{64}$/)
    })

    it('should return consistent hash for same input', () => {
      const hash1 = hashTargetingKey('user-123')
      const hash2 = hashTargetingKey('user-123')
      assert.strictEqual(hash1, hash2)
    })

    it('should return different hash for different input', () => {
      const hash1 = hashTargetingKey('user-123')
      const hash2 = hashTargetingKey('user-456')
      assert.notStrictEqual(hash1, hash2)
    })

    it('should match expected hash values', () => {
      // Pre-computed SHA256 hashes for known values
      // echo -n "test-user-sha256" | sha256sum
      const hash = hashTargetingKey('test-user-sha256')
      assert.strictEqual(hash, '03730d38b223ba74db02c81f18c1fd0d1f0d63939d09a1e1413341c56b748eca')
    })

    it('should handle empty string', () => {
      const hash = hashTargetingKey('')
      // SHA256 of empty string
      assert.strictEqual(hash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    })

    it('should handle unicode characters', () => {
      const hash = hashTargetingKey('用户-123')
      assert.strictEqual(hash.length, 64)
      assert.match(hash, /^[0-9a-f]{64}$/)
    })
  })
})
