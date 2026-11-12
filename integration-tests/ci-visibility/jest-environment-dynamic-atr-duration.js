'use strict'

const NodeEnvironment =
  require('jest-environment-node').TestEnvironment ||
  require('jest-environment-node')

class DynamicAtrDurationEnvironment extends NodeEnvironment {
  durations = process.env.DYNAMIC_ATR_TEST_DURATIONS?.split(',').map(Number)

  /** @param {...unknown} args */
  constructor (...args) {
    super(...args)
    if (process.env.DYNAMIC_ATR_PREVENT_EXTENSIONS) {
      Object.preventExtensions(this)
    }
  }

  handleTestEvent (event, state) {
    if (event.name === 'test_done') {
      // Exercise the >5m dynamic ATR bucket without making the integration test wait five minutes.
      event.test.duration = this.durations
        ? (event.test.invocations === 1 ? this.durations.shift() : 300_001)
        : 300_001
    }
    if (process.env.DYNAMIC_ATR_REPORT_ERRORS && event.name === 'run_describe_finish') {
      for (const test of event.describeBlock.children) {
        if (test.type === 'test') {
          process.stdout.write(`DYNAMIC_ATR_RESULT:${JSON.stringify({
            name: test.name,
            errors: test.errors.length,
            invocations: test.invocations,
          })}\n`)
        }
      }
    }
    if (!process.env.DYNAMIC_ATR_SKIP_SUPER) {
      return super.handleTestEvent?.(event, state)
    }
  }
}

module.exports = DynamicAtrDurationEnvironment
