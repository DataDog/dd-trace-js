'use strict'

module.exports = {
  use (impl) {
    Object.assign(this, impl)
  },
  env () {
    // need this stub for early config
  },
  service () {
    // need this stub for early config
  },
  appVersion () {
    // need this stub for early config
  }
}
