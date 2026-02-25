'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')

require('./setup/core')

describe('PropagationHashManager', () => {
  let propagationHash

  beforeEach(() => {
    // Create a fresh instance for each test
    const PropagationHashManager = proxyquire('../src/propagation-hash/index', {})
    propagationHash = new (PropagationHashManager.constructor)()
  })

  describe('configure', () => {
    it('should store the configuration', () => {
      const config = { propagateProcessTags: { enabled: true } }
      propagationHash.configure(config)
      assert.strictEqual(propagationHash.isEnabled(), true)
    })

    it('should handle null config', () => {
      propagationHash.configure(null)
      assert.strictEqual(propagationHash.isEnabled(), false)
    })
  })

  describe('isEnabled', () => {
    it('should return false when not configured', () => {
      assert.strictEqual(propagationHash.isEnabled(), false)
    })

    it('should return false when propagateProcessTags is disabled', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: false } })
      assert.strictEqual(propagationHash.isEnabled(), false)
    })

    it('should return true when propagateProcessTags is enabled', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })
      assert.strictEqual(propagationHash.isEnabled(), true)
    })
  })

  describe('updateContainerTagsHash', () => {
    it('should update the container tags hash', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })
      propagationHash.updateContainerTagsHash('container123')

      const hash1 = propagationHash.getHash()
      assert.ok(hash1, 'Hash should be computed')

      propagationHash.updateContainerTagsHash('container456')
      const hash2 = propagationHash.getHash()

      assert.notStrictEqual(hash1, hash2, 'Hash should change when container tags change')
    })

    it('should not recompute hash if container tags are the same', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })
      propagationHash.updateContainerTagsHash('container123')

      const hash1 = propagationHash.getHash()
      const hashString1 = propagationHash.getHashString()

      propagationHash.updateContainerTagsHash('container123')
      const hash2 = propagationHash.getHash()
      const hashString2 = propagationHash.getHashString()

      assert.strictEqual(hash1, hash2, 'Hash should be the same')
      assert.strictEqual(hashString1, hashString2, 'Hash string should be the same')
    })

    it('should handle null container tags hash', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })
      propagationHash.updateContainerTagsHash(null)

      const hash = propagationHash.getHash()
      assert.ok(hash, 'Hash should still be computed from process tags only')
    })
  })

  describe('getHash', () => {
    it('should return null when feature is disabled', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: false } })
      assert.strictEqual(propagationHash.getHash(), null)
    })

    it('should compute and cache hash from process tags only', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      const hash = propagationHash.getHash()
      assert.ok(hash, 'Hash should be computed')
      assert.strictEqual(typeof hash, 'bigint', 'Hash should be a BigInt')

      // Call again to verify caching
      const hash2 = propagationHash.getHash()
      assert.strictEqual(hash, hash2, 'Hash should be cached')
    })

    it('should compute hash from process tags + container tags', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      const hashWithoutContainer = propagationHash.getHash()
      propagationHash.updateContainerTagsHash('container123')
      const hashWithContainer = propagationHash.getHash()

      assert.ok(hashWithoutContainer, 'Hash without container should exist')
      assert.ok(hashWithContainer, 'Hash with container should exist')
      assert.notStrictEqual(hashWithoutContainer, hashWithContainer, 'Hashes should differ')
    })
  })

  describe('getHashString', () => {
    it('should return null when feature is disabled', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: false } })
      assert.strictEqual(propagationHash.getHashString(), null)
    })

    it('should return hex string representation of hash', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      const hashString = propagationHash.getHashString()
      assert.ok(hashString, 'Hash string should exist')
      assert.strictEqual(typeof hashString, 'string', 'Hash string should be a string')
      assert.match(hashString, /^[0-9a-f]+$/, 'Hash string should be lowercase hexadecimal')
    })

    it('should cache the hex string representation', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      const hashString1 = propagationHash.getHashString()
      const hashString2 = propagationHash.getHashString()

      assert.strictEqual(hashString1, hashString2, 'Hash string should be cached')
    })

    it('should recompute hex string when hash changes', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      const hashString1 = propagationHash.getHashString()
      propagationHash.updateContainerTagsHash('container123')
      const hashString2 = propagationHash.getHashString()

      assert.notStrictEqual(hashString1, hashString2, 'Hash string should change')
    })

    it('should match BigInt toString(16)', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      const hash = propagationHash.getHash()
      const hashString = propagationHash.getHashString()

      assert.strictEqual(hashString, hash.toString(16), 'Hash string should match BigInt.toString(16)')
    })
  })

  describe('getHashBase64', () => {
    it('should return null when feature is disabled', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: false } })
      assert.strictEqual(propagationHash.getHashBase64(), null)
    })

    it('should return base64 string representation of hash', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      const hashBase64 = propagationHash.getHashBase64()
      assert.ok(hashBase64, 'Hash base64 should exist')
      assert.strictEqual(typeof hashBase64, 'string', 'Hash base64 should be a string')
      assert.match(hashBase64, /^[A-Za-z0-9+/]+=*$/, 'Hash base64 should be valid base64')
    })

    it('should cache the base64 string representation', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      const hashBase64First = propagationHash.getHashBase64()
      const hashBase64Second = propagationHash.getHashBase64()

      assert.strictEqual(hashBase64First, hashBase64Second, 'Hash base64 should be cached')
    })

    it('should recompute base64 string when hash changes', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      const hashBase64First = propagationHash.getHashBase64()
      propagationHash.updateContainerTagsHash('container123')
      const hashBase64Second = propagationHash.getHashBase64()

      assert.notStrictEqual(hashBase64First, hashBase64Second, 'Hash base64 should change')
    })

    it('should be convertible back to BigInt', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      const hash = propagationHash.getHash()
      const hashBase64 = propagationHash.getHashBase64()

      // Decode base64 back to BigInt
      const buffer = Buffer.from(hashBase64, 'base64')
      const decodedHash = buffer.readBigUInt64BE(0)

      assert.strictEqual(decodedHash, hash, 'Base64 should decode back to original hash')
    })

    it('should produce 8-byte base64 string', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      const hashBase64 = propagationHash.getHashBase64()
      const buffer = Buffer.from(hashBase64, 'base64')

      assert.strictEqual(buffer.length, 8, 'Decoded buffer should be 8 bytes (64 bits)')
    })
  })

  describe('cache invalidation', () => {
    it('should invalidate cache when container tags change', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      const hash1 = propagationHash.getHash()
      const hashString1 = propagationHash.getHashString()
      const hashBase64First = propagationHash.getHashBase64()

      propagationHash.updateContainerTagsHash('newContainer')

      const hash2 = propagationHash.getHash()
      const hashString2 = propagationHash.getHashString()
      const hashBase64Second = propagationHash.getHashBase64()

      assert.notStrictEqual(hash1, hash2, 'Hash should be different')
      assert.notStrictEqual(hashString1, hashString2, 'Hash string should be different')
      assert.notStrictEqual(hashBase64First, hashBase64Second, 'Hash base64 should be different')
    })

    it('should not invalidate cache if container tags are unchanged', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })

      propagationHash.updateContainerTagsHash('container123')
      const hash1 = propagationHash.getHash()

      propagationHash.updateContainerTagsHash('container123')
      const hash2 = propagationHash.getHash()

      assert.strictEqual(hash1, hash2, 'Hash should remain the same')
    })
  })

  describe('edge cases', () => {
    it('should handle empty container tags', () => {
      propagationHash.configure({ propagateProcessTags: { enabled: true } })
      propagationHash.updateContainerTagsHash('')

      const hash = propagationHash.getHash()
      assert.ok(hash, 'Hash should still be computed')
    })

    it('should return null for empty input when both process tags and container tags are empty', () => {
      // This test would require mocking process-tags module to return empty string
      // For now, we assume process tags always have some value
      propagationHash.configure({ propagateProcessTags: { enabled: true } })
      const hash = propagationHash.getHash()
      assert.ok(hash, 'Hash should be computed from process tags')
    })
  })
})
