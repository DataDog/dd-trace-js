'use strict'

const crypto = globalThis.crypto

const BUFFER_SIZE = 8192

const data = new BigUint64Array(BUFFER_SIZE)

let batch = 0

function single () {
  prefill()

  return data[batch] & 0x7fffffffffffffffn
}

function double () {
  return single() + (single() << 64n)
}

function prefill () {
  if (batch === 0) {
    crypto.getRandomValues(data)
  }

  batch = (batch + 1) % BUFFER_SIZE
}

function fromString (value, raddix = 10) {
  return BigInt(raddix === 16 ? `0x${value}` : value)
}

function toString (value, radix = 10) {
  return value.toString(radix)
}

module.exports = { single, double, fromString, toString, zero: 0n }
