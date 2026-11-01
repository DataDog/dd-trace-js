'use strict'

const environment = require('jest-environment-node')
const NodeEnvironment = environment.TestEnvironment || environment
const teardown = NodeEnvironment.prototype.teardown

// Preload before the tracer so its environment wrapper sees both teardown failure contracts.
NodeEnvironment.prototype.teardown = function () {
  const result = teardown.call(this)
  const error = new TypeError('expected environment teardown failure')
  if (process.env.JEST_TEARDOWN_ERROR_MODE === 'sync') throw error
  return result.then(() => { throw error })
}
