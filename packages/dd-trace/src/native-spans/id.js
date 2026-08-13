'use strict'

const { randomFillSync } = require('node:crypto')

// One `randomFillSync` per 8192 ids. Two lanes per id, so 16384 words.
const RANDOM_LANES = new Uint32Array(8192 * 2)
let randomCursor = RANDOM_LANES.length

/**
 * A trace or span id held as `Uint32Array` lanes rather than a `BigUint64Array`
 * element or a byte buffer: a 64-bit id is `(hi, lo)`, a 128-bit trace id adds
 * `(upperHi, upperLo)` above them. Reproduced microbenchmarking put lane pairs
 * 6-8.5x ahead of `BigUint64Array` for this access pattern once embedded in
 * interleaved, class-method-shaped code, and the hot path — filling an
 * `EventWriter` record — reads the lanes straight across with no `BigInt` in
 * sight.
 *
 * `toString` / `toBigInt` / `toBuffer` stay lazy-cached cold-path methods for the
 * rare callers that need a string, `BigInt`, or byte form: propagation headers,
 * `toTraceId()`, logging.
 */
class NativeId {
  /** @type {bigint | undefined} */
  #bigInt
  /** @type {string | undefined} */
  #hex
  /** @type {string | undefined} */
  #decimal
  /** @type {Uint8Array | undefined} */
  #buffer

  /**
   * @param {number} hi Bits 32-63, as a uint32.
   * @param {number} lo Bits 0-31, as a uint32.
   * @param {number} [upperHi] Bits 96-127 of a 128-bit trace id.
   * @param {number} [upperLo] Bits 64-95 of a 128-bit trace id.
   */
  constructor (hi, lo, upperHi = 0, upperLo = 0) {
    this.hi = hi
    this.lo = lo
    this.upperHi = upperHi
    this.upperLo = upperLo
  }

  /**
   * @param {number} [radix]
   * @returns {string}
   */
  toString (radix = 16) {
    if (radix === 16) {
      this.#hex ??= this.upperHi === 0 && this.upperLo === 0
        ? hex32(this.hi) + hex32(this.lo)
        : hex32(this.upperHi) + hex32(this.upperLo) + hex32(this.hi) + hex32(this.lo)
      return this.#hex
    }
    if (radix === 10) {
      this.#decimal ??= this.toBigInt().toString(10)
      return this.#decimal
    }
    return this.toBigInt().toString(radix)
  }

  /**
   * The low 64 bits, which is what every id-shaped wire field carries.
   *
   * @returns {bigint}
   */
  toBigInt () {
    this.#bigInt ??= (BigInt(this.hi) << 32n) | BigInt(this.lo)
    return this.#bigInt
  }

  /**
   * Big-endian bytes of the low 64 bits, matching `id.js`'s `toBuffer()` so the
   * v0.5 id layout and the binary propagator see the same shape.
   *
   * @returns {Uint8Array}
   */
  toBuffer () {
    if (this.#buffer === undefined) {
      const buffer = new Uint8Array(8)
      buffer[0] = this.hi >>> 24
      buffer[1] = this.hi >>> 16
      buffer[2] = this.hi >>> 8
      buffer[3] = this.hi
      buffer[4] = this.lo >>> 24
      buffer[5] = this.lo >>> 16
      buffer[6] = this.lo >>> 8
      buffer[7] = this.lo
      this.#buffer = buffer
    }
    return this.#buffer
  }

  /**
   * @returns {Uint8Array}
   */
  toArray () {
    return this.toBuffer()
  }

  /**
   * @returns {string}
   */
  toJSON () {
    return this.toString()
  }

  /**
   * Full 128-bit hex when this id carries an upper half, otherwise the 64-bit
   * form prefixed with `traceIdHigh` the way `id.js` does it.
   *
   * @param {string | undefined} traceIdHigh
   * @returns {string}
   */
  toTraceIdHex (traceIdHigh) {
    if (traceIdHigh && this.upperHi === 0 && this.upperLo === 0) {
      return traceIdHigh + this.toString(16)
    }
    return this.toString(16)
  }

  /**
   * @param {NativeId} other
   * @returns {boolean}
   */
  equals (other) {
    return this.hi === other.hi && this.lo === other.lo
  }
}

/**
 * @param {number} value uint32
 * @returns {string} 8 lowercase hex characters.
 */
function hex32 (value) {
  return (value >>> 0).toString(16).padStart(8, '0')
}

/**
 * A pseudo-random, non-negative 64-bit id. The top bit is cleared so the value
 * stays a positive int64, same constraint `id.js` applies.
 *
 * @returns {NativeId}
 */
function randomId () {
  if (randomCursor === RANDOM_LANES.length) {
    randomFillSync(RANDOM_LANES)
    randomCursor = 0
  }
  const hi = RANDOM_LANES[randomCursor] & 0x7F_FF_FF_FF
  const lo = RANDOM_LANES[randomCursor + 1]
  randomCursor += 2
  return new NativeId(hi, lo)
}

/**
 * A 128-bit trace id shaped like the one `span.js` builds for the baseline: the
 * lower 64 bits are the root span id, the upper 64 are the start time in seconds
 * in their top half and zeroes below — the same value the baseline writes as the
 * `_dd.p.tid` chunk tag.
 *
 * @param {NativeId} rootSpanId
 * @param {number} startTimeMs
 * @returns {NativeId}
 */
function traceIdFrom (rootSpanId, startTimeMs) {
  return new NativeId(rootSpanId.hi, rootSpanId.lo, Math.floor(startTimeMs / 1000), 0)
}

const ZERO_ID = new NativeId(0, 0)

module.exports = { NativeId, ZERO_ID, randomId, traceIdFrom }
