'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')
const MsgpackChunk = require('../../src/msgpack/chunk')

const DEFAULT_MIN_SIZE = 1024 * 1024
const SHRINK_AFTER_FLUSHES = 32

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
})
