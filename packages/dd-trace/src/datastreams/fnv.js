'use strict'

const FNV_64_PRIME = 0x1_00_00_00_01_B3n
const FNV1_64_INIT = 0xCB_F2_9C_E4_84_22_23_25n

function fnv (data, hvalInit, fnvPrime, fnvSize) {
  let hval = hvalInit
  for (const byte of data) {
    hval = (hval * fnvPrime) % fnvSize
    hval ^= BigInt(byte)
  }
  return hval
}

function fnv64 (data) {
  if (!Buffer.isBuffer(data)) {
    data = Buffer.from(data, 'utf8')
  }
  const byteArray = new Uint8Array(data)
  return fnv(byteArray, FNV1_64_INIT, FNV_64_PRIME, 2n ** 64n)
}

/**
 * FNV-1 64 of `data`, written into `target` at `offset` as a uint64 little-endian. With `seed`, an
 * earlier result in the same layout, it continues that hash, like dd-trace-java's
 * FNV64Hash.continueHash.
 *
 * Same hash as `fnv64`, computed on two uint32 halves because BigInt arithmetic per byte is several
 * times slower on the per-message DSM path. FNV_64_PRIME is 2^40 + 0x1b3, so multiplying by it is
 * a 40-bit shift plus a multiply by 0x1b3, and every intermediate stays below 2^53.
 *
 * @param {Uint8Array} data
 * @param {Buffer} target
 * @param {number} offset
 * @param {Buffer} [seed]
 */
function writeFnv64LE (data, target, offset, seed) {
  let high = seed === undefined ? 0xCB_F2_9C_E4 : seed.readUInt32LE(4)
  let low = seed === undefined ? 0x84_22_23_25 : seed.readUInt32LE(0)
  for (let i = 0; i < data.length; i++) {
    const lowProduct = low * 0x1_B3
    high = (high * 0x1_B3 + Math.floor(lowProduct / 0x1_00_00_00_00) + (low << 8)) >>> 0
    low = ((lowProduct >>> 0) ^ data[i]) >>> 0
  }
  target.writeUInt32LE(low, offset)
  target.writeUInt32LE(high, offset + 4)
}

module.exports = {
  fnv64,
  writeFnv64LE,
}
