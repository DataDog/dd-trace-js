'use strict'

module.exports = {
  use (impl) {
    Object.assign(this, impl)
  }
}
