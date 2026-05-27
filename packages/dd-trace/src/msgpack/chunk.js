'use strict'

const DEFAULT_MIN_SIZE = 1024 * 1024 // 1 MiB
// Number of consecutive `reset()` calls whose peak usage stayed under
// `SHRINK_USAGE_RATIO * buffer.length` before the buffer halves. Picked high
// enough that a one-off burst keeps the grown buffer warm.
const SHRINK_AFTER_FLUSHES = 32
// Peak fraction of the current buffer the next flush must beat to keep the
// shrink streak from advancing. 1/4 — a quarter — matches the doubling growth
// shape: after a halving step the post-shrink fill is the prior peak doubled,
// still under 50 %.
const SHRINK_USAGE_RATIO = 4

/**
 * Resizable msgpack write buffer. Owns the byte-layout primitives the encoder
 * layer dispatches into; callers reach the underlying `Buffer` only when they
 * need to assemble a fused write (pre-computed prefixes, span-id payloads).
 *
 * Growth doubles the capacity per `reserve`; shrink halves it after
 * `SHRINK_AFTER_FLUSHES` consecutive `reset()` calls left the buffer barely
 * filled. Both stop at `minSize` so callers can pin a floor (CI Visibility's
 * payload prefix chunk uses ~2 KiB).
 */
class MsgpackChunk {
  #minSize
  #lowUsageStreak = 0

  constructor (minSize = DEFAULT_MIN_SIZE) {
    this.buffer = Buffer.allocUnsafe(minSize)
    this.view = new DataView(this.buffer.buffer)
    this.length = 0
    this.#minSize = minSize
  }

  /**
   * Emit `value` as a msgpack string (fixstr for < 32 bytes, str32 otherwise).
   * Returns the number of bytes written so callers can subarray the underlying
   * buffer at the resulting position.
   *
   * @param {string} value
   * @returns {number}
   */
  write (value) {
    const length = Buffer.byteLength(value)
    const offset = this.length

    if (length < 0x20) { // fixstr
      this.reserve(length + 1)
      this.buffer[offset] = length | 0xA0
    } else if (length < 0x1_00_00_00_00) { // str 32
      this.reserve(length + 5)
      this.buffer[offset] = 0xDB
      this.buffer[offset + 1] = length >> 24
      this.buffer[offset + 2] = length >> 16
      this.buffer[offset + 3] = length >> 8
      this.buffer[offset + 4] = length
    }

    this.buffer.utf8Write(value, this.length - length, length)

    return this.length - offset
  }

  /**
   * Copy this chunk's used bytes into `target` starting at `target[0]`. Used
   * by `AgentEncoder.makePayload` to assemble the final wire buffer.
   *
   * @param {Buffer} target
   * @param {number} sourceStart
   * @param {number} sourceEnd
   */
  copy (target, sourceStart, sourceEnd) {
    target.set(new Uint8Array(this.buffer.buffer, sourceStart, sourceEnd - sourceStart))
  }

  /**
   * Append a raw byte sequence to the chunk. Caller-supplied bytes are
   * trusted; this is the fused-prefix path.
   *
   * @param {Uint8Array | Buffer} array
   */
  set (array) {
    const length = this.length

    this.reserve(array.length)

    this.buffer.set(array, length)
  }

  /**
   * Reserve `size` more bytes after the current cursor, growing the backing
   * buffer if needed. The cursor advances unconditionally so subsequent
   * writes can assume the room is available.
   *
   * @param {number} size
   */
  reserve (size) {
    const needed = this.length + size

    if (needed > this.buffer.length) {
      let newSize = this.buffer.length
      // `*= 2` instead of `<<= 1`: `1073741824 << 1` is negative as int32,
      // and msgpack values can legitimately reach the multi-GiB range.
      while (newSize < needed) newSize *= 2
      this.#resize(newSize)
    }

    this.length += size
  }

  /**
   * Mark the buffer as flushed: zero the cursor and, when the previous flush
   * barely filled the buffer for `SHRINK_AFTER_FLUSHES` consecutive resets,
   * halve the backing buffer. A single high-watermark flush resets the
   * streak. Long-lived encoders can therefore grow under bursts and give the
   * memory back during quiet periods without the user having to recreate the
   * chunk.
   */
  reset () {
    const peak = this.length

    this.length = 0

    if (this.buffer.length > this.#minSize && peak * SHRINK_USAGE_RATIO < this.buffer.length) {
      if (++this.#lowUsageStreak >= SHRINK_AFTER_FLUSHES) {
        const newSize = Math.max(this.#minSize, this.buffer.length >>> 1)
        this.buffer = Buffer.allocUnsafe(newSize)
        this.view = new DataView(this.buffer.buffer)
        this.#lowUsageStreak = 0
      }
    } else {
      this.#lowUsageStreak = 0
    }
  }

  writeNull () {
    const offset = this.length

    this.reserve(1)
    this.buffer[offset] = 0xC0
  }

  /**
   * @param {boolean} value
   */
  writeBoolean (value) {
    const offset = this.length

    this.reserve(1)
    this.buffer[offset] = value ? 0xC3 : 0xC2
  }

  /**
   * @param {number} size 0..15.
   */
  writeFixArray (size = 0) {
    const offset = this.length

    this.reserve(1)
    this.buffer[offset] = 0x90 + size
  }

  /**
   * Reserve a 5-byte array32 header with `value.length` slots. Used when the
   * length is not known to fit in fixarray.
   *
   * @param {{ length: number }} value
   */
  writeArrayPrefix (value) {
    const length = value.length
    const offset = this.length

    this.reserve(5)
    this.buffer[offset] = 0xDD
    this.buffer[offset + 1] = length >> 24
    this.buffer[offset + 2] = length >> 16
    this.buffer[offset + 3] = length >> 8
    this.buffer[offset + 4] = length
  }

  /**
   * @param {number} size 0..15.
   */
  writeFixMap (size = 0) {
    const offset = this.length

    this.reserve(1)
    this.buffer[offset] = 0x80 + size
  }

  /**
   * Reserve a 5-byte map32 header with `keysLength` entries.
   *
   * @param {number} keysLength
   */
  writeMapPrefix (keysLength) {
    const offset = this.length

    this.reserve(5)
    this.buffer[offset] = 0xDF
    this.buffer[offset + 1] = keysLength >> 24
    this.buffer[offset + 2] = keysLength >> 16
    this.buffer[offset + 3] = keysLength >> 8
    this.buffer[offset + 4] = keysLength
  }

  /**
   * Write a single raw byte. Used by `0.5.js` for the fixarray-of-twelve span
   * marker.
   *
   * @param {number} value
   */
  writeByte (value) {
    this.reserve(1)
    this.buffer[this.length - 1] = value
  }

  /**
   * @param {Buffer | Uint8Array} value
   */
  writeBin (value) {
    const offset = this.length

    if (value.byteLength < 256) {
      this.reserve(2)
      this.buffer[offset] = 0xC4
      this.buffer[offset + 1] = value.byteLength
    } else if (value.byteLength < 65_536) {
      this.reserve(3)
      this.buffer[offset] = 0xC5
      this.buffer[offset + 1] = value.byteLength >> 8
      this.buffer[offset + 2] = value.byteLength
    } else {
      this.reserve(5)
      this.buffer[offset] = 0xC6
      this.buffer[offset + 1] = value.byteLength >> 24
      this.buffer[offset + 2] = value.byteLength >> 16
      this.buffer[offset + 3] = value.byteLength >> 8
      this.buffer[offset + 4] = value.byteLength
    }

    this.set(value)
  }

  /**
   * Write `value` as msgpack uint32 (`0xCE` + 4 bytes), regardless of
   * magnitude. Callers that want the shortest encoding should use `writeUint`.
   *
   * @param {number} value
   */
  writeInteger (value) {
    const offset = this.length

    this.reserve(5)
    this.buffer[offset] = 0xCE
    this.buffer[offset + 1] = value >> 24
    this.buffer[offset + 2] = value >> 16
    this.buffer[offset + 3] = value >> 8
    this.buffer[offset + 4] = value
  }

  /**
   * Write `value` as msgpack uint64 (`0xCF` + 8 bytes).
   *
   * @param {number} value
   */
  writeLong (value) {
    const offset = this.length
    const hi = (value / 2 ** 32) >> 0
    const lo = value >>> 0

    this.reserve(9)
    this.buffer[offset] = 0xCF
    this.buffer[offset + 1] = hi >> 24
    this.buffer[offset + 2] = hi >> 16
    this.buffer[offset + 3] = hi >> 8
    this.buffer[offset + 4] = hi
    this.buffer[offset + 5] = lo >> 24
    this.buffer[offset + 6] = lo >> 16
    this.buffer[offset + 7] = lo >> 8
    this.buffer[offset + 8] = lo
  }

  /**
   * Pick the shortest valid msgpack uint encoding for a non-negative integer.
   *
   * @param {number} value
   */
  writeUnsigned (value) {
    const offset = this.length

    if (value <= 0x7F) {
      this.reserve(1)
      this.buffer[offset] = value
    } else if (value <= 0xFF) {
      this.reserve(2)
      this.buffer[offset] = 0xCC
      this.buffer[offset + 1] = value
    } else if (value <= 0xFF_FF) {
      this.reserve(3)
      this.buffer[offset] = 0xCD
      this.buffer[offset + 1] = value >> 8
      this.buffer[offset + 2] = value
    } else if (value <= 0xFF_FF_FF_FF) {
      this.reserve(5)
      this.buffer[offset] = 0xCE
      this.buffer[offset + 1] = value >> 24
      this.buffer[offset + 2] = value >> 16
      this.buffer[offset + 3] = value >> 8
      this.buffer[offset + 4] = value
    } else {
      const hi = (value / 2 ** 32) >> 0
      const lo = value >>> 0

      this.reserve(9)
      this.buffer[offset] = 0xCF
      this.buffer[offset + 1] = hi >> 24
      this.buffer[offset + 2] = hi >> 16
      this.buffer[offset + 3] = hi >> 8
      this.buffer[offset + 4] = hi
      this.buffer[offset + 5] = lo >> 24
      this.buffer[offset + 6] = lo >> 16
      this.buffer[offset + 7] = lo >> 8
      this.buffer[offset + 8] = lo
    }
  }

  /**
   * Pick the shortest valid msgpack int encoding for a negative integer.
   *
   * @param {number} value
   */
  writeSigned (value) {
    const offset = this.length

    if (value >= -0x20) {
      this.reserve(1)
      this.buffer[offset] = value
    } else if (value >= -0x80) {
      this.reserve(2)
      this.buffer[offset] = 0xD0
      this.buffer[offset + 1] = value
    } else if (value >= -0x80_00) {
      this.reserve(3)
      this.buffer[offset] = 0xD1
      this.buffer[offset + 1] = value >> 8
      this.buffer[offset + 2] = value
    } else if (value >= -0x80_00_00_00) {
      this.reserve(5)
      this.buffer[offset] = 0xD2
      this.buffer[offset + 1] = value >> 24
      this.buffer[offset + 2] = value >> 16
      this.buffer[offset + 3] = value >> 8
      this.buffer[offset + 4] = value
    } else {
      const hi = Math.floor(value / 2 ** 32)
      const lo = value >>> 0

      this.reserve(9)
      this.buffer[offset] = 0xD3
      this.buffer[offset + 1] = hi >> 24
      this.buffer[offset + 2] = hi >> 16
      this.buffer[offset + 3] = hi >> 8
      this.buffer[offset + 4] = hi
      this.buffer[offset + 5] = lo >> 24
      this.buffer[offset + 6] = lo >> 16
      this.buffer[offset + 7] = lo >> 8
      this.buffer[offset + 8] = lo
    }
  }

  // TODO: Support BigInt larger than 64bit.
  /**
   * @param {bigint} value
   */
  writeBigInt (value) {
    const offset = this.length

    this.reserve(9)

    if (value >= 0n) {
      this.buffer[offset] = 0xCF
      this.view.setBigUint64(offset + 1, value)
    } else {
      this.buffer[offset] = 0xD3
      this.view.setBigInt64(offset + 1, value)
    }
  }

  /**
   * @param {number} value
   */
  writeFloat (value) {
    const offset = this.length

    this.reserve(9)
    this.buffer[offset] = 0xCB
    this.view.setFloat64(offset + 1, value)
  }

  /**
   * Pick the shortest valid msgpack number encoding for `value`. `NaN`
   * collapses to fixint 0 — callers that need to preserve `NaN` (the tracer's
   * span numeric path) should use `writeIntOrFloat` instead.
   *
   * @param {number} value
   */
  writeNumber (value) {
    if (Number.isNaN(value)) {
      value = 0
    }
    if (Number.isInteger(value)) {
      if (value >= 0) {
        this.writeUnsigned(value)
      } else {
        this.writeSigned(value)
      }
    } else {
      this.writeFloat(value)
    }
  }

  /**
   * Emit `value` as the smallest valid msgpack number encoding: compact
   * unsigned/signed int when integer, float64 otherwise. Unlike `writeNumber`,
   * NaN keeps its float64 bits instead of coercing to fixint 0. Used on the
   * tracer hot path so the agent sees the value the application produced.
   *
   * @param {number} value
   */
  writeIntOrFloat (value) {
    // Fast path: positive fixint (0..127). `value === (value & 0x7F)` is true
    // iff `value` is an exact integer in that range — covers `error: 0/1`,
    // priority flags, attribute counts, HTTP status codes mapped to numbers,
    // and most small metrics. NaN, ±Infinity, negatives, and any non-integer
    // float fall through.
    if (value === (value & 0x7F)) {
      const offset = this.length
      this.reserve(1)
      this.buffer[offset] = value
      return
    }
    if (Number.isInteger(value)) {
      if (value >= 0) {
        this.writeUnsigned(value)
      } else {
        this.writeSigned(value)
      }
    } else {
      this.writeFloat(value)
    }
  }

  #resize (size) {
    const oldBuffer = this.buffer

    this.buffer = Buffer.allocUnsafe(size)
    this.view = new DataView(this.buffer.buffer)

    oldBuffer.copy(this.buffer, 0, 0, this.length)
  }
}

module.exports = MsgpackChunk
