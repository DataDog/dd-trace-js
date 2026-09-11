'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')

const { describe, it, beforeEach, afterEach } = require('mocha')
require('../../setup/mocha')

const JSONBuffer = require('../../../src/debugger/devtools_client/json-buffer')

const MAX_SAFE_SIGNED_INTEGER = 2 ** 31 - 1

describe('JSONBuffer', () => {
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
  })

  describe('timeout-based flushing', () => {
    it('should call onFlush with the expected payload when the timeout is reached', function () {
      let flushedJson
      const onFlush = (json) => {
        flushedJson = json
      }

      const jsonBuffer = new JSONBuffer({
        size: Infinity,
        maxQueueBytes: Infinity,
        timeout: 100,
        onFlush,
      })

      jsonBuffer.write(JSON.stringify({ message: 1 }))
      jsonBuffer.write(JSON.stringify({ message: 2 }))
      jsonBuffer.write(JSON.stringify({ message: 3 }))

      clock.tick(99)
      assert.strictEqual(flushedJson, undefined, 'Should not flush before timeout')

      clock.tick(1)
      assert.strictEqual(flushedJson, '[{"message":1},{"message":2},{"message":3}]')
    })

    it('should reset timeout when writing after a timeout-based flush', function () {
      let flushCount = 0
      const onFlush = () => { flushCount++ }

      const jsonBuffer = new JSONBuffer({
        size: Infinity,
        maxQueueBytes: Infinity,
        timeout: 100,
        onFlush,
      })

      jsonBuffer.write(JSON.stringify({ message: 1 }))

      // Let first message flush via timeout
      clock.tick(100)
      assert.strictEqual(flushCount, 1, 'Should have flushed first message')

      // Write again - timeout should be reset from this point
      jsonBuffer.write(JSON.stringify({ message: 2 }))

      // Should need full 100ms from the second write
      clock.tick(99)
      assert.strictEqual(flushCount, 1, 'Should not flush yet')

      clock.tick(1)
      assert.strictEqual(flushCount, 2, 'Should flush after full timeout period')
    })

    it('should reset state properly after flush', function () {
      const flushedPayloads = []
      const onFlush = (json) => flushedPayloads.push(json)

      const jsonBuffer = new JSONBuffer({
        size: Infinity,
        maxQueueBytes: Infinity,
        timeout: 100,
        onFlush,
      })

      jsonBuffer.write(JSON.stringify({ message: 1 }))
      jsonBuffer.write(JSON.stringify({ message: 2 }))

      clock.tick(100)
      assert.strictEqual(flushedPayloads.length, 1)
      assert.strictEqual(flushedPayloads[0], '[{"message":1},{"message":2}]')

      // Write after flush - should start a new buffer
      jsonBuffer.write(JSON.stringify({ message: 3 }))
      jsonBuffer.write(JSON.stringify({ message: 4 }))

      clock.tick(100)
      assert.strictEqual(flushedPayloads.length, 2)
      assert.strictEqual(flushedPayloads[1], '[{"message":3},{"message":4}]')
    })
  })

  describe('size-based flushing', () => {
    it('should call onFlush with the expected payload when the size is reached', function () {
      const expectedPayloads = [
        '[{"message":1},{"message":2}]',
        '[{"message":3},{"message":4}]',
      ]

      const onFlush = (json) => {
        assert.strictEqual(json, expectedPayloads.shift())
      }

      const jsonBuffer = new JSONBuffer({
        size: 30,
        maxQueueBytes: Infinity,
        timeout: MAX_SAFE_SIGNED_INTEGER,
        onFlush,
      })

      jsonBuffer.write(JSON.stringify({ message: 1 })) // size: 15
      jsonBuffer.write(JSON.stringify({ message: 2 })) // size: 29
      jsonBuffer.write(JSON.stringify({ message: 3 })) // size: 15 (flushed, and re-added)
      jsonBuffer.write(JSON.stringify({ message: 4 })) // size: 29
      jsonBuffer.write(JSON.stringify({ message: 5 })) // size: 15 (flushed, and re-added)

      assert.strictEqual(expectedPayloads.length, 0, 'All expected payloads should have been flushed')
    })

    it('should handle writing exactly at the size limit', function () {
      let flushedJson
      const onFlush = (json) => {
        flushedJson = json
      }

      // '[{"a":1},{"b":2}]' = 19 bytes exactly
      const jsonBuffer = new JSONBuffer({
        size: 19,
        maxQueueBytes: Infinity,
        timeout: MAX_SAFE_SIGNED_INTEGER,
        onFlush,
      })

      jsonBuffer.write(JSON.stringify({ a: 1 })) // '[{"a":1}' = 8 bytes
      assert.strictEqual(flushedJson, undefined, 'Should not flush after first write')

      jsonBuffer.write(JSON.stringify({ b: 2 })) // ',{"b":2}]' = 11 more bytes = 19 total
      assert.strictEqual(flushedJson, undefined, 'Should not flush when exactly at limit')

      jsonBuffer.write(JSON.stringify({ c: 3 })) // Would exceed, so flush first
      assert.strictEqual(flushedJson, '[{"a":1},{"b":2}]')
    })

    it('should handle a single message larger than maxSize', function () {
      const flushedPayloads = []
      const onFlush = (json) => flushedPayloads.push(json)

      const jsonBuffer = new JSONBuffer({
        size: 10,
        maxQueueBytes: Infinity,
        timeout: MAX_SAFE_SIGNED_INTEGER,
        onFlush,
      })

      const largeMessage = JSON.stringify({ message: 'very long message that exceeds size' })
      jsonBuffer.write(largeMessage) // Single message > 10 bytes

      // Should still buffer it (no flush yet)
      assert.strictEqual(flushedPayloads.length, 0)

      // Writing another message should flush the large one
      jsonBuffer.write(JSON.stringify({ msg: 2 }))
      assert.strictEqual(flushedPayloads.length, 1)
      assert.strictEqual(flushedPayloads[0], `[${largeMessage}]`)
    })

    it('should use provided size parameter instead of calculating', function () {
      const flushedPayloads = []
      const onFlush = (json) => flushedPayloads.push(json)

      const jsonBuffer = new JSONBuffer({
        size: 20,
        maxQueueBytes: Infinity,
        timeout: MAX_SAFE_SIGNED_INTEGER,
        onFlush,
      })

      const msg1 = JSON.stringify({ msg: 1 })
      jsonBuffer.write(msg1) // 10 bytes
      assert.strictEqual(flushedPayloads.length, 0)

      const msg2 = JSON.stringify({ msg: 2 })
      // Actual size would be 10 + 10 + 2 = 22, but claim it's only 5 bytes
      // This means 10 + 5 + 2 = 17 <= 20, so it won't flush
      jsonBuffer.write(msg2, 5)
      assert.strictEqual(flushedPayloads.length, 0, 'Should not flush due to fake size')

      const msg3 = JSON.stringify({ msg: 3 })
      // Now actual partialJson is '[{"msg":1},{"msg":2}' = 21 bytes
      // Adding msg3: 21 + 10 + 2 = 33 > 20, so flush
      jsonBuffer.write(msg3)
      assert.strictEqual(flushedPayloads.length, 1)
      assert.strictEqual(flushedPayloads[0], `[${msg1},${msg2}]`)
    })

    it('should clear timer when size limit is reached and create new timer on recursive write', function () {
      let flushCount = 0
      const onFlush = () => { flushCount++ }

      const jsonBuffer = new JSONBuffer({
        size: 30,
        maxQueueBytes: Infinity,
        timeout: 100,
        onFlush,
      })

      jsonBuffer.write(JSON.stringify({ message: 1 })) // 15 bytes, starts timer
      clock.tick(50) // Advance time but don't trigger timeout

      jsonBuffer.write(JSON.stringify({ message: 2 })) // 29 bytes
      jsonBuffer.write(JSON.stringify({ message: 3 })) // Exceeds limit, flushes and recursively writes msg 3

      assert.strictEqual(flushCount, 1, 'Should have flushed due to size')

      // Original timer was cleared, so ticking 99ms (149ms total) shouldn't flush
      clock.tick(99)
      assert.strictEqual(flushCount, 1, 'Original timer was cleared, should not flush')

      // New timer for message 3 needs full 100ms from the recursive write
      clock.tick(1)
      assert.strictEqual(flushCount, 2, 'Should flush message 3 after its full timeout')
    })
  })

  describe('queue bound', () => {
    it('should count the batch and the flushed payloads still in flight towards the bound', function () {
      const releases = []
      const onFlush = (json, done) => releases.push(done)

      // '[{"a":1}]' is 9 bytes, so each single-document payload occupies 9 bytes until released
      const jsonBuffer = new JSONBuffer({ size: 9, maxQueueBytes: 27, timeout: MAX_SAFE_SIGNED_INTEGER, onFlush })

      assert.strictEqual(jsonBuffer.write(JSON.stringify({ a: 1 })), true)
      assert.strictEqual(jsonBuffer.queuedBytes, 8, 'the closing bracket is only added when flushing')
      assert.strictEqual(jsonBuffer.write(JSON.stringify({ b: 2 })), true, 'should flush the first document')
      assert.strictEqual(releases.length, 1)
      assert.strictEqual(jsonBuffer.queuedBytes, 17)
      assert.strictEqual(jsonBuffer.write(JSON.stringify({ c: 3 })), true, 'should flush the second document')
      assert.strictEqual(releases.length, 2)
      assert.strictEqual(jsonBuffer.queuedBytes, 26)

      // The third document is flushed (26 -> 27 bytes in flight), but the fourth no longer fits
      assert.strictEqual(jsonBuffer.write(JSON.stringify({ d: 4 })), false)
      assert.strictEqual(releases.length, 3)
      assert.strictEqual(jsonBuffer.queuedBytes, 27)

      releases[0]()
      assert.strictEqual(jsonBuffer.queuedBytes, 18)
      assert.strictEqual(jsonBuffer.write(JSON.stringify({ d: 4 })), true, 'should accept documents again')
      assert.strictEqual(jsonBuffer.queuedBytes, 26)
    })

    it('should accept a document that exactly fits within the bound', function () {
      // '[{"a":1}]' is 9 bytes once flushed
      const jsonBuffer = new JSONBuffer({
        size: 100,
        maxQueueBytes: 9,
        timeout: MAX_SAFE_SIGNED_INTEGER,
        onFlush () {},
      })

      assert.strictEqual(jsonBuffer.write(JSON.stringify({ a: 1 })), true)
      assert.strictEqual(jsonBuffer.queuedBytes, 8, 'the closing bracket is only added when flushing')
    })

    it('should reject a document that does not fit within the bound even when nothing is queued', function () {
      const jsonBuffer = new JSONBuffer({
        size: 100,
        maxQueueBytes: 8,
        timeout: MAX_SAFE_SIGNED_INTEGER,
        onFlush () {},
      })

      assert.strictEqual(jsonBuffer.write(JSON.stringify({ a: 1 })), false)
      assert.strictEqual(jsonBuffer.queuedBytes, 0)
    })

    it('should not release a flushed payload twice', function () {
      const releases = []
      const jsonBuffer = new JSONBuffer({
        size: 9,
        maxQueueBytes: 100,
        timeout: MAX_SAFE_SIGNED_INTEGER,
        onFlush: (json, done) => releases.push(done),
      })

      jsonBuffer.write(JSON.stringify({ a: 1 }))
      jsonBuffer.write(JSON.stringify({ b: 2 }))
      jsonBuffer.write(JSON.stringify({ c: 3 }))
      assert.strictEqual(jsonBuffer.queuedBytes, 26)

      releases[0]()
      releases[0]()
      assert.strictEqual(jsonBuffer.queuedBytes, 17)
    })

    it('should release the bytes of a payload flushed by the timeout', function () {
      /** @type {(() => void) | undefined} */
      let release
      const jsonBuffer = new JSONBuffer({
        size: Infinity,
        maxQueueBytes: 100,
        timeout: 100,
        onFlush: (json, done) => { release = done },
      })

      jsonBuffer.write(JSON.stringify({ message: 1 }))
      jsonBuffer.write(JSON.stringify({ message: 2 }))
      clock.tick(100)

      assert.strictEqual(jsonBuffer.queuedBytes, 29)
      assert.ok(release, 'should have flushed')
      release()
      assert.strictEqual(jsonBuffer.queuedBytes, 0)
    })

    it('should not keep a document that triggered a flush when the flushed payload fills the bound', function () {
      const flushedPayloads = []
      const jsonBuffer = new JSONBuffer({
        size: 20,
        maxQueueBytes: 25,
        timeout: 100,
        onFlush: (json) => flushedPayloads.push(json),
      })

      jsonBuffer.write(JSON.stringify({ a: 1 })) // 8 bytes
      jsonBuffer.write(JSON.stringify({ b: 2 })) // 16 bytes
      assert.strictEqual(jsonBuffer.write(JSON.stringify({ c: 3 })), false) // flushes 17 bytes, 17 + 9 > 25

      assert.deepStrictEqual(flushedPayloads, ['[{"a":1},{"b":2}]'])
      assert.strictEqual(jsonBuffer.queuedBytes, 17)

      clock.tick(100)
      assert.strictEqual(flushedPayloads.length, 1, 'should not flush an empty payload')
    })
  })

  describe('edge cases', () => {
    it('should handle rapid successive writes', function () {
      let flushedJson
      const onFlush = (json) => {
        flushedJson = json
      }

      const jsonBuffer = new JSONBuffer({
        size: Infinity,
        maxQueueBytes: Infinity,
        timeout: 100,
        onFlush,
      })

      for (let i = 1; i <= 10; i++) {
        jsonBuffer.write(JSON.stringify({ num: i }))
      }

      clock.tick(100)
      assert.ok(flushedJson, 'Should have flushed data')
      const parsed = JSON.parse(flushedJson)
      assert.deepStrictEqual(parsed, [
        { num: 1 }, { num: 2 }, { num: 3 }, { num: 4 }, { num: 5 },
        { num: 6 }, { num: 7 }, { num: 8 }, { num: 9 }, { num: 10 },
      ])
    })

    it('should handle empty buffer timeout', function () {
      let flushCount = 0
      const onFlush = () => { flushCount++ }

      // Create buffer but don't write anything - we're testing that nothing happens
      // eslint-disable-next-line no-new
      new JSONBuffer({ size: Infinity, maxQueueBytes: Infinity, timeout: 100, onFlush })

      clock.tick(100)
      assert.strictEqual(flushCount, 0, 'Should not flush if nothing was written')
    })

    it('should handle consecutive writes that each exceed size limit', function () {
      const flushedPayloads = []
      const onFlush = (json) => flushedPayloads.push(json)

      const jsonBuffer = new JSONBuffer({
        size: 15,
        maxQueueBytes: Infinity,
        timeout: MAX_SAFE_SIGNED_INTEGER,
        onFlush,
      })

      jsonBuffer.write(JSON.stringify({ a: 1 })) // 8 bytes, buffered
      jsonBuffer.write(JSON.stringify({ b: 2 })) // 8 + 10 + 2 = 20 > 15, flush a, buffer b
      jsonBuffer.write(JSON.stringify({ c: 3 })) // 8 + 10 + 2 = 20 > 15, flush b, buffer c
      jsonBuffer.write(JSON.stringify({ d: 4 })) // 8 + 10 + 2 = 20 > 15, flush c, buffer d

      assert.strictEqual(flushedPayloads.length, 3)
      assert.strictEqual(flushedPayloads[0], '[{"a":1}]')
      assert.strictEqual(flushedPayloads[1], '[{"b":2}]')
      assert.strictEqual(flushedPayloads[2], '[{"c":3}]')
    })
  })
})
