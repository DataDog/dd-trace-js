'use strict'

const pprof = require('pprof/out/src/profile-encoder')

module.exports = (profile) => {
  return pprof.encode(profile)
}