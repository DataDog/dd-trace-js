'use strict'

module.exports = {
  use (impl) {
    Object.assign(this, impl)
  },
  env (name) {
    // need this stub for early config
    return typeof window !== 'undefined' ? window[name] : process.env[name]
  },
  service () {
    // need this stub for early config
  },
  appVersion () {
    // need this stub for early config
  }
}
