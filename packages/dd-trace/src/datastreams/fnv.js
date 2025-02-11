const FNV_64_PRIME = BigInt('0x100000001B3')
const FNV1_64_INIT = BigInt('0xCBF29CE484222325')

function fnv (data, hvalInit, fnvPrime, fnvSize) {
  let hval = hvalInit
  for (const byte of data) {
    hval = (hval * fnvPrime) % fnvSize
    hval = hval ^ BigInt(byte)
  }
  return hval
}

function fnv64 (data) {
  if (!Buffer.isBuffer(data)) {
    data = Buffer.from(data, 'utf-8')
  }
  const byteArray = new Uint8Array(data)
  return fnv(byteArray, FNV1_64_INIT, FNV_64_PRIME, 2n ** 64n)
}

module.exports = {
  fnv64
}
