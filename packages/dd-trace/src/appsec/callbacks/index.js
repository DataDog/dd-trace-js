'use strict'

// lazy loading
// TODO: cache the returned value
module.exports = {
  get DDWAF () { return require('./ddwaf') }
}
