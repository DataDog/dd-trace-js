'use strict'

class FrozenReporter {
  constructor () {
    Object.freeze(this)
  }

  onEnd () {}
}

module.exports = FrozenReporter
