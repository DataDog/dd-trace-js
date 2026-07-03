'use strict'

const NodeEnvironment =
  require('jest-environment-node').TestEnvironment ||
  require('jest-environment-node')

class CustomEnvironment extends NodeEnvironment {
  handleTestEvent (event) {
    if (event.name === 'add_test') {
      return new Promise(() => {})
    }
  }
}

module.exports = CustomEnvironment
