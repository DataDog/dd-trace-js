'use strict'

const NodeEnvironment =
  require('jest-environment-node').TestEnvironment ||
  require('jest-environment-node')

class DynamicAtrDurationEnvironment extends NodeEnvironment {
  durations = process.env.DYNAMIC_ATR_TEST_DURATIONS?.split(',').map(Number)

  handleTestEvent (event, state) {
    if (event.name === 'test_done') {
      // Exercise the >5m dynamic ATR bucket without making the integration test wait five minutes.
      event.test.duration = this.durations
        ? (event.test.invocations === 1 ? this.durations.shift() : 300_001)
        : 300_001
    }
    return super.handleTestEvent?.(event, state)
  }
}

module.exports = DynamicAtrDurationEnvironment
