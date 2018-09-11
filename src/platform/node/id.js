'use strict'

const Buffer = require('safe-buffer').Buffer
const Uint64BE = require('int64-buffer').Uint64BE
const randomBytes = require('crypto').randomBytes

const hiSeed = randomBytes(4).readUInt32BE()
const loSeed = randomBytes(4).readUInt32BE()

function pseudoRandom () {
  const buffer = Buffer.allocUnsafe(8)

  const hi = randomUInt32(hiSeed) & 0x7FFFFFFF // only positive int64
  const lo = randomUInt32(loSeed)

  writeUInt32BE(buffer, hi, 0)
  writeUInt32BE(buffer, lo, 4)

  return buffer
}

function randomUInt32 (seed) {
  return seed ^ Math.floor(Math.random() * (0xFFFFFFFF + 1))
}

function writeUInt32BE (buffer, value, offset) {
  buffer[3 + offset] = value & 255
  value = value >> 8
  buffer[2 + offset] = value & 255
  value = value >> 8
  buffer[1 + offset] = value & 255
  value = value >> 8
  buffer[0 + offset] = value & 255
}

module.exports = () => new Uint64BE(pseudoRandom())
