'use strict'

const crypto = require('crypto')

// MD5 hashing using Node.js crypto for consistent sharding
function getMD5Hash(input, salt = '') {
  return crypto.createHash('md5').update(salt + input).digest('hex')
}

class Sharder {
  getShard(input, totalShards) {
    throw new Error('Abstract method must be implemented')
  }
}

class MD5Sharder extends Sharder {
  getShard(input, totalShards) {
    const hashOutput = getMD5Hash(input)
    // get the first 4 bytes of the md5 hex string and parse it using base 16
    // (8 hex characters represent 4 bytes, e.g. 0xffffffff represents the max 4-byte integer)
    const intFromHash = parseInt(hashOutput.slice(0, 8), 16)
    return intFromHash % totalShards
  }
}

class DeterministicSharder extends Sharder {
  /*
  Deterministic sharding based on a look-up table
  to simplify writing tests
  */
  constructor(lookup) {
    super()
    this.lookup = lookup
  }

  getShard(input, _totalShards) {
    return this.lookup[input] ?? 0
  }
}

module.exports = {
  Sharder,
  MD5Sharder,
  DeterministicSharder
}