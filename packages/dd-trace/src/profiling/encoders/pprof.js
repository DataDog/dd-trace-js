'use strict'

const { gzip } = require('zlib')
const { perftools } = require('../../../../../protobuf/profile')
const { Profile } = perftools.profiles

class Encoder {
  encode (profile, callback) {
    try {
      gzip(Profile.encode(profile).finish(), callback)
    } catch (e) {
      callback(e)
    }
  }
}

module.exports = { Encoder }
