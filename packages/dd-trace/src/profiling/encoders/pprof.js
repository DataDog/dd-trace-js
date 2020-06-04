'use strict'

const util = require('util')
const zlib = require('zlib')
const gzip = util.promisify(zlib.gzip)
const { perftools } = require('../../../../../proto/profile')
const { Profile } = perftools.profiles

class Encoder {
  async encode (profile) {
    return gzip(Profile.encode(profile).finish())
  }
}

module.exports = { Encoder }
