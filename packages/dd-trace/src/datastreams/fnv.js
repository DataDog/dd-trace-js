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

module.exports = {
  fnv64
}
