'use strict'

const { randomFillSync } = require('crypto')
const { closeSync, openSync, readSync } = require('fs')

const UINT_MAX = 4_294_967_296

const data = new Uint8Array(8 * 8192)
const zeroId = new Uint8Array(8)

let batch = 0

// Swappable fill source. Default: OpenSSL DRBG via randomFillSync.
// reseed() permanently replaces this with fillFromKernel once the MicroVM /run
// hook fires, so every subsequent batch refill draws from the kernel CSPRNG.
let fill = randomFillSync

// File descriptor for /dev/urandom; opened once by reseed(). -1 means not yet
// opened or unavailable (non-Linux), causing fillFromKernel to fall back to randomFillSync.
let urandomFd = -1

// Fill `buffer` from the kernel CSPRNG (/dev/urandom). Falls back to
// randomFillSync and disables the fd permanently on any read failure so the
// hot path never keeps retrying a broken fd. dd-trace must never crash the app.
/**
 * @param {Uint8Array | Buffer} buffer
 */
function fillFromKernel (buffer) {
  if (urandomFd !== -1) {
    try {
      let offset = 0
      while (offset < buffer.length) {
        const bytesRead = readSync(urandomFd, buffer, offset, buffer.length - offset, null)
        if (bytesRead <= 0) break
        offset += bytesRead
      }
      if (offset === buffer.length) return
    } catch {
      // fall through to randomFillSync
    }
    try {
      closeSync(urandomFd)
    } catch {
      // ignore
    }
    urandomFd = -1
  }
  randomFillSync(buffer)
}

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

// Simple pseudo-random 64-bit ID generator.
/**
 * @returns {number[] | Uint8Array}
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
 * Switches the batch fill source permanently from OpenSSL's DRBG to the kernel
 * CSPRNG (/dev/urandom) and resets the batch cursor, forcing the next
 * pseudoRandom() call to refill from post-resume kernel entropy.
 *
 * Called once by proxy.js#refreshIdentity() when the Lambda MicroVM `/run`
 * lifecycle hook fires. At that point VMGenID has already reseeded the kernel
 * CSPRNG, so the next batch and all subsequent batches are unique per clone.
 * Idempotent: a second call from a late SIGUSR2 is a fast no-op.
 */
function reseed () {
  if (fill === fillFromKernel) return
  try {
    urandomFd = openSync('/dev/urandom', 'r')
  } catch {
    // Keep urandomFd = -1; fillFromKernel falls back to randomFillSync.
  }
  fill = fillFromKernel
  batch = 0
}

/**
 * Generates a RFC 4122 v4 UUID using the kernel CSPRNG (/dev/urandom).
 * Falls back to randomFillSync if /dev/urandom is unavailable.
 *
 * Use this instead of crypto.randomUUID() when entropy must be kernel-derived
 * (e.g. after a Firecracker snapshot restore where OpenSSL's DRBG state is
 * frozen and may not yet have reseeded from the post-VMGenID kernel entropy).
 *
 * @returns {string}
 */
function kernelUUID () {
  const buf = Buffer.allocUnsafe(16)
  fillFromKernel(buf)
  buf[6] = (buf[6] & 0x0f) | 0x40 // version 4
  buf[8] = (buf[8] & 0x3f) | 0x80 // variant 10xx
  const h = buf.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
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
module.exports.reseed = reseed
module.exports.kernelUUID = kernelUUID
