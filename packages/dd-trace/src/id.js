'use strict'

const { randomFillSync } = require('crypto')
const { openSync, readSync } = require('fs')

const UINT_MAX = 4_294_967_296

const data = new Uint8Array(8 * 8192)
const zeroId = new Uint8Array(8)

let batch = 0

// `data` is batch-filled 8192 ids at a time from `fill`. The default source is
// OpenSSL's DRBG (randomFillSync); reseed() swaps it for the kernel CSPRNG when
// running in a MicroVM. See reseed() for why.
let fill = randomFillSync
let urandomFd = -1

// Internal representation of a trace or span ID.
class Identifier {
  /** @type {number[] | Uint8Array} */
  #buffer
  /** @type {bigint | undefined} */
  #bigInt
  /** @type {string | undefined} */
  #stringHex
  /** @type {string | undefined} */
  #stringDecimal

  /**
   * @param {string} value
   * @param {number} [radix]
   */
  constructor (value, radix = 16) {
    this.#buffer = radix === 16
      ? createBuffer(value)
      : fromString(value, radix)
  }

  /**
   * @param {number} [radix]
   * @returns {string}
   */
  toString (radix = 16) {
    if (radix === 16) {
      this.#stringHex ??= Buffer.from(this.#buffer).toString('hex')
      return this.#stringHex
    }
    if (radix === 10) {
      this.#stringDecimal ??= toNumberString(this.#buffer, 10)
      return this.#stringDecimal
    }
    return toNumberString(this.#buffer, radix)
  }

  /**
   * @returns {bigint}
   */
  toBigInt () {
    this.#bigInt ??= Buffer.from(this.#buffer).readBigUInt64BE(0)
    return this.#bigInt
  }

  /**
   * @returns {number[] | Uint8Array}
   */
  toBuffer () {
    return this.#buffer
  }

  /**
   * @returns {number[] | Uint8Array}
   */
  toArray () {
    if (this.#buffer.length === 8) {
      return this.#buffer
    }
    return this.#buffer.slice(-8)
  }

  /**
   * @returns {string}
   */
  toJSON () {
    return this.toString()
  }

  /**
   * Returns the full hex trace ID. When this is a 64-bit identifier and `traceIdHigh`
   * is provided, prepends it to form the 128-bit trace ID. Otherwise returns
   * only this identifier's hex representation.
   *
   * @param {string | undefined} traceIdHigh - 16-char hex of the upper 64 bits, or undefined
   * @returns {string}
   */
  toTraceIdHex (traceIdHigh) {
    if (traceIdHigh && this.#buffer.length <= 8) {
      return traceIdHigh + this.toString(16)
    }
    return this.toString(16)
  }

  /**
   * @param {Identifier} other
   * @returns {boolean}
   */
  equals (other) {
    // Big-endian suffix compare: when buffers differ in length, only the
    // rightmost `min(this.length, other.length)` bytes are checked.
    for (let i = this.#buffer.length - 1, j = other.#buffer.length - 1; i >= 0 && j >= 0; i--, j--) {
      if (this.#buffer[i] !== other.#buffer[j]) return false
    }

    return true
  }
}

// Create a buffer, using an optional hexadecimal value if provided.
/**
 * @param {string} value
 * @returns {number[] | Uint8Array}
 */
function createBuffer (value) {
  if (value === '0') return zeroId
  if (!value) return pseudoRandom()

  const size = Math.ceil(value.length / 16) * 16
  const bytes = size / 2
  const buffer = []

  value = value.padStart(size, '0')

  for (let i = 0; i < bytes; i++) {
    buffer[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  }

  return buffer
}

// Convert a numerical string to a buffer using the specified radix.
/**
 * @param {string} str
 * @param {number} raddix
 * @returns {number[]}
 */
function fromString (str, raddix) {
  const buffer = new Array(8)
  const len = str.length

  let pos = 0
  let high = 0
  let low = 0

  if (str[0] === '-') pos++

  const sign = pos

  while (pos < len) {
    const chr = Number.parseInt(str[pos++], raddix)

    if (!(chr >= 0)) break // NaN

    low = low * raddix + chr
    high = high * raddix + Math.floor(low / UINT_MAX)
    low %= UINT_MAX
  }

  if (sign) {
    high = ~high

    if (low) {
      low = UINT_MAX - low
    } else {
      high++
    }
  }

  writeUInt32BE(buffer, high, 0)
  writeUInt32BE(buffer, low, 4)

  return buffer
}

// Convert a buffer to a numerical string.
/**
 * @param {number[] | Uint8Array} buffer
 * @param {number} [radix]
 * @returns {string}
 */
function toNumberString (buffer, radix) {
  let high = readInt32(buffer, buffer.length - 8)
  let low = readInt32(buffer, buffer.length - 4)
  let str = ''

  radix = radix || 10

  while (1) {
    const mod = (high % radix) * UINT_MAX + low

    high = Math.floor(high / radix)
    low = Math.floor(mod / radix)
    str = (mod % radix).toString(radix) + str

    if (!high && !low) break
  }

  return str
}

// Simple pseudo-random 64-bit ID generator (non-MicroVM batch path).
/**
 * @returns {number[]}
 */
function pseudoRandom () {
  if (batch === 0) {
    fill(data)
  }

  batch = (batch + 1) % 8192

  const offset = batch * 8

  return [
    data[offset] & 0x7F, // only positive int64,
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
    data[offset + 4],
    data[offset + 5],
    data[offset + 6],
    data[offset + 7],
  ]
}

// Fill `buffer` from the kernel CSPRNG, which Firecracker reseeds per clone on
// snapshot resume (VMGenID). Falls back to randomFillSync only when /dev/urandom
// can't be opened (non-Linux, locked-down sandbox) -- no worse than the default.
/**
 * @param {Uint8Array} buffer
 */
function fillFromKernel (buffer) {
  if (urandomFd === -1) {
    randomFillSync(buffer)
    return
  }

  let offset = 0
  while (offset < buffer.length) {
    offset += readSync(urandomFd, buffer, offset, buffer.length - offset, null)
  }
}

// Read a buffer to unsigned integer bytes.
/**
 * @param {number[] | Uint8Array} buffer
 * @param {number} offset
 * @returns {number}
 */
function readInt32 (buffer, offset) {
  return (buffer[offset + 0] * 16_777_216) +
    (buffer[offset + 1] << 16) +
    (buffer[offset + 2] << 8) +
    buffer[offset + 3]
}

// Write unsigned integer bytes to a buffer.
/**
 * @param {number[] | Uint8Array} buffer
 * @param {number} value
 * @param {number} offset
 */
function writeUInt32BE (buffer, value, offset) {
  buffer[3 + offset] = value & 255
  value >>= 8
  buffer[2 + offset] = value & 255
  value >>= 8
  buffer[1 + offset] = value & 255
  value >>= 8
  buffer[0 + offset] = value & 255
}

/**
 * @param {string} [value]
 * @param {number} [radix]
 * @returns {Identifier}
 */
module.exports = function createIdentifier (value, radix) {
  return new Identifier(value ?? '', radix)
}

module.exports.Identifier = Identifier

// A Firecracker/Lambda MicroVM resumes many clones from one memory snapshot.
// The snapshot freezes OpenSSL's DRBG state and the pre-filled `data` buffer, so
// every clone would otherwise replay the same trace/span IDs. Only the guest
// kernel CSPRNG is reseeded per clone, so on the first invocation after a
// possible restore we switch batch fills to /dev/urandom and discard the
// snapshot's pre-fill. The Lambda handler calls this per invocation; it's a
// no-op after the first, since a clone only has to switch once.
module.exports.reseed = function reseed () {
  if (fill === fillFromKernel) {
    return
  }

  try {
    urandomFd = openSync('/dev/urandom', 'r')
  } catch {
    // Keep urandomFd = -1; fillFromKernel falls back to randomFillSync.
  }

  fill = fillFromKernel
  batch = 0
}
