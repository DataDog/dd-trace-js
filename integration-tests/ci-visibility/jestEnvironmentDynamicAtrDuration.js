'use strict'

const NodeEnvironment =
  require('jest-environment-node').TestEnvironment ||
  require('jest-environment-node')

class DynamicAtrDurationEnvironment extends NodeEnvironment {
  handleTestEvent (event, state) {
    if (event.name === 'test_done') {
      // Exercise the >5m dynamic ATR bucket without making the integration test wait five minutes.
      event.test.duration = 300_001
    }
    return super.handleTestEvent(event, state)
  }
}

module.exports = DynamicAtrDurationEnvironment
