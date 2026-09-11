'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const AudioAccumulator = require('../../src/openai-realtime/audio-accumulator')
const {
  LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES,
} = require('../../../dd-trace/src/llmobs/constants/audio')

/**
 * @param {number[]} bytes
 * @returns {string}
 */
function b64 (bytes) {
  return Buffer.from(bytes).toString('base64')
}

/**
 * Append `sizes` frames of distinct, position-encoding bytes so a trim or cap can be checked to have
 * cut at the right offset rather than merely to have the right length.
 *
 * @param {number[]} sizes
 * @returns {{ accumulator: AudioAccumulator, all: Buffer }}
 */
function accumulate (sizes) {
  const accumulator = new AudioAccumulator()
  const all = []
  let next = 0

  for (const size of sizes) {
    const frame = Array.from({ length: size }, () => next++ % 256)
    all.push(...frame)
    accumulator.append(b64(frame), 1000)
  }

  return { accumulator, all: Buffer.from(all) }
}

describe('openai realtime AudioAccumulator', () => {
  describe('append', () => {
    it('decodes the frame and reports its byte count', () => {
      const accumulator = new AudioAccumulator()

      assert.strictEqual(accumulator.append(b64([1, 2, 3, 4]), 1000), 4)
      assert.strictEqual(accumulator.totalDecodedBytes, 4)
      assert.deepStrictEqual(accumulator.toBuffer(), Buffer.from([1, 2, 3, 4]))
    })

    it('anchors startTime on the first frame only', () => {
      const accumulator = new AudioAccumulator()

      accumulator.append(b64([1]), 1000)
      accumulator.append(b64([2]), 2000)

      assert.strictEqual(accumulator.startTime, 1000)
      assert.strictEqual(accumulator.present, true)
    })

    it('ignores a missing or non-string frame without marking the segment present', () => {
      const accumulator = new AudioAccumulator()

      assert.strictEqual(accumulator.append('', 1000), 0)
      assert.strictEqual(accumulator.append(undefined, 1000), 0)
      assert.strictEqual(accumulator.append(Buffer.from([1]), 1000), 0)

      assert.strictEqual(accumulator.present, false)
      assert.strictEqual(accumulator.startTime, undefined)
      assert.strictEqual(accumulator.totalDecodedBytes, 0)
    })

    // The retention cap is a memory bound. Pin the last accepted size and the first rejected one.
    it('retains audio of exactly the cap', () => {
      const accumulator = new AudioAccumulator()
      accumulator.append(Buffer.alloc(LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES).toString('base64'), 1000)

      assert.strictEqual(accumulator.oversize, false)
      assert.strictEqual(accumulator.toBuffer().length, LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES)
    })

    it('drops the retained audio one byte past the cap, but keeps counting the segment', () => {
      const accumulator = new AudioAccumulator()
      accumulator.append(Buffer.alloc(LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES).toString('base64'), 1000)
      accumulator.append(b64([1]), 2000)

      assert.strictEqual(accumulator.oversize, true)
      assert.strictEqual(accumulator.toBuffer().length, 0)
      // `present` and `totalDecodedBytes` survive so the turn can still surface a marker and derive
      // its speaking window from the byte count.
      assert.strictEqual(accumulator.present, true)
      assert.strictEqual(accumulator.totalDecodedBytes, LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES + 1)
      assert.strictEqual(accumulator.startTime, 1000)
    })

    it('keeps counting further frames once oversize without retaining them', () => {
      const accumulator = new AudioAccumulator()
      accumulator.append(Buffer.alloc(LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES + 1).toString('base64'), 1000)

      assert.strictEqual(accumulator.append(b64([1, 2]), 2000), 2)
      assert.strictEqual(accumulator.totalDecodedBytes, LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES + 3)
      assert.strictEqual(accumulator.toBuffer().length, 0)
    })
  })

  describe('trimLeading', () => {
    it('drops whole leading frames', () => {
      const { accumulator, all } = accumulate([4, 4, 4])

      accumulator.trimLeading(8)

      assert.deepStrictEqual(accumulator.toBuffer(), all.subarray(8))
      assert.strictEqual(accumulator.totalDecodedBytes, 4)
    })

    // Unlike dd-trace-py, which trims whole base64 frames and so leaves up to one frame of lead-in,
    // decoded buffers let the cut land exactly on the requested byte.
    it('cuts mid-frame at the exact byte', () => {
      const { accumulator, all } = accumulate([10, 10])

      accumulator.trimLeading(3)

      assert.deepStrictEqual(accumulator.toBuffer(), all.subarray(3))
      assert.strictEqual(accumulator.totalDecodedBytes, 17)
    })

    it('cuts across a frame boundary at the exact byte', () => {
      const { accumulator, all } = accumulate([4, 4, 4])

      accumulator.trimLeading(6)

      assert.deepStrictEqual(accumulator.toBuffer(), all.subarray(6))
      assert.strictEqual(accumulator.totalDecodedBytes, 6)
    })

    it('is a no-op for a non-positive trim', () => {
      const { accumulator, all } = accumulate([4])

      accumulator.trimLeading(0)
      accumulator.trimLeading(-5)

      assert.deepStrictEqual(accumulator.toBuffer(), all)
      assert.strictEqual(accumulator.totalDecodedBytes, 4)
    })

    it('clears the segment when the whole thing precedes the onset', () => {
      const { accumulator } = accumulate([4, 4])

      accumulator.trimLeading(8)

      assert.strictEqual(accumulator.toBuffer().length, 0)
      assert.strictEqual(accumulator.totalDecodedBytes, 0)
      assert.strictEqual(accumulator.present, false)
      assert.strictEqual(accumulator.startTime, undefined)
    })

    // A long silent lead-in can spend the retention cap before the speech even starts. Clearing must
    // reopen the accumulator, or the turn keeps nothing but an `[audio]` marker.
    it('reopens a segment once the surviving audio is back under the cap', () => {
      const accumulator = new AudioAccumulator()
      accumulator.append(Buffer.alloc(LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES).toString('base64'), 1000)
      accumulator.append(b64([1, 2, 3, 4]), 2000)
      assert.strictEqual(accumulator.oversize, true)

      // Shed the lead-in that spent the cap, but not the whole segment.
      accumulator.trimLeading(LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES)

      assert.strictEqual(accumulator.oversize, false)
      assert.strictEqual(accumulator.totalDecodedBytes, 4)
    })

    it('reopens a segment the lead-in had already pushed oversize', () => {
      const accumulator = new AudioAccumulator()
      accumulator.append(Buffer.alloc(LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES + 1).toString('base64'), 1000)
      assert.strictEqual(accumulator.oversize, true)

      accumulator.trimLeading(LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES + 1)
      assert.strictEqual(accumulator.oversize, false)

      accumulator.append(b64([7, 8]), 2000)

      assert.deepStrictEqual(accumulator.toBuffer(), Buffer.from([7, 8]))
      assert.strictEqual(accumulator.totalDecodedBytes, 2)
      assert.strictEqual(accumulator.startTime, 2000)
    })
  })

  describe('segment format', () => {
    it('records the format in force when the first frame arrived', () => {
      const accumulator = new AudioAccumulator()

      accumulator.append(b64([1, 2]), 1000, 'audio/pcm', 24_000)

      assert.strictEqual(accumulator.mimeType, 'audio/pcm')
      assert.strictEqual(accumulator.sampleRate, 24_000)
    })

    // A segment keeps the format it was captured under, so a `session.update` part-way through a
    // turn cannot retime bytes that arrived before it.
    it('keeps the first frame\'s format when a later frame reports a different one', () => {
      const accumulator = new AudioAccumulator()

      accumulator.append(b64([1, 2]), 1000, 'audio/pcm', 24_000)
      accumulator.append(b64([3, 4]), 2000, 'audio/pcmu', 8000)

      assert.strictEqual(accumulator.mimeType, 'audio/pcm')
      assert.strictEqual(accumulator.sampleRate, 24_000)
    })

    it('records no format when the session had not announced one', () => {
      const accumulator = new AudioAccumulator()

      accumulator.append(b64([1, 2]), 1000)

      assert.strictEqual(accumulator.mimeType, '')
      assert.strictEqual(accumulator.sampleRate, 0)
    })

    it('forgets the format on clear, so the next segment records its own', () => {
      const accumulator = new AudioAccumulator()

      accumulator.append(b64([1, 2]), 1000, 'audio/pcm', 24_000)
      accumulator.clear()
      accumulator.append(b64([3, 4]), 2000, 'audio/pcmu', 8000)

      assert.strictEqual(accumulator.mimeType, 'audio/pcmu')
      assert.strictEqual(accumulator.sampleRate, 8000)
    })
  })

  describe('capTo', () => {
    it('splits the straddling frame rather than dropping it', () => {
      const { accumulator, all } = accumulate([10, 10])

      accumulator.capTo(13)

      assert.deepStrictEqual(accumulator.toBuffer(), all.subarray(0, 13))
      assert.strictEqual(accumulator.totalDecodedBytes, 13)
    })

    // A response delivered as one big delta would lose all of its heard audio if the cap stopped at
    // the previous frame boundary.
    it('keeps the heard prefix of a single large frame', () => {
      const { accumulator, all } = accumulate([100])

      accumulator.capTo(30)

      assert.deepStrictEqual(accumulator.toBuffer(), all.subarray(0, 30))
    })

    it('drops whole trailing frames', () => {
      const { accumulator, all } = accumulate([4, 4, 4])

      accumulator.capTo(8)

      assert.deepStrictEqual(accumulator.toBuffer(), all.subarray(0, 8))
      assert.strictEqual(accumulator.totalDecodedBytes, 8)
    })

    it('is a no-op when the cap is at or past the end', () => {
      const { accumulator, all } = accumulate([4, 4])

      accumulator.capTo(8)
      accumulator.capTo(99)

      assert.deepStrictEqual(accumulator.toBuffer(), all)
      assert.strictEqual(accumulator.totalDecodedBytes, 8)
    })

    // Absolute and shrink-only, so a client truncation and the server's echo of it apply once.
    it('never grows the segment back on a second, larger cap', () => {
      const { accumulator, all } = accumulate([10, 10])

      accumulator.capTo(5)
      accumulator.capTo(15)

      assert.deepStrictEqual(accumulator.toBuffer(), all.subarray(0, 5))
      assert.strictEqual(accumulator.totalDecodedBytes, 5)
    })

    it('clears the segment when nothing was heard', () => {
      const { accumulator } = accumulate([4, 4])

      accumulator.capTo(0)

      assert.strictEqual(accumulator.toBuffer().length, 0)
      assert.strictEqual(accumulator.present, false)
      assert.strictEqual(accumulator.totalDecodedBytes, 0)
    })
  })

  describe('toBuffer', () => {
    it('concatenates frames in order', () => {
      const { accumulator, all } = accumulate([3, 5, 7])
      assert.deepStrictEqual(accumulator.toBuffer(), all)
    })

    it('returns an empty buffer for an untouched segment', () => {
      assert.deepStrictEqual(new AudioAccumulator().toBuffer(), Buffer.alloc(0))
    })
  })

  describe('clear', () => {
    it('resets every field', () => {
      const { accumulator } = accumulate([4, 4])

      accumulator.clear()

      assert.deepStrictEqual(accumulator.chunks, [])
      assert.strictEqual(accumulator.present, false)
      assert.strictEqual(accumulator.oversize, false)
      assert.strictEqual(accumulator.startTime, undefined)
      assert.strictEqual(accumulator.totalDecodedBytes, 0)
      assert.strictEqual(accumulator.toBuffer().length, 0)
    })
  })
})
