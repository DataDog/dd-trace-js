'use strict'

const NodeEnvironment =
  require('jest-environment-node').TestEnvironment ||
  require('jest-environment-node')

class CustomEnvironment extends NodeEnvironment {
  handleTestEvent = async (event, state) => {
    if (!this.global.JEST_STATE_SYMBOL) {
      this.global.JEST_STATE_SYMBOL = state
    }
  }
}

module.exports = CustomEnvironment
