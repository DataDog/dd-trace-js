'use strict'

const environment = require('jest-environment-node')
const NodeEnvironment = environment.TestEnvironment || environment

class TeardownErrorEnvironment extends NodeEnvironment {
  /** @param {...unknown} args */
  constructor (...args) {
    super(...args)
    if (process.env.JEST_TEARDOWN_DEFINITION !== 'field') Object.preventExtensions(this)
  }

  teardown () {
    return this.runTeardown()
  }

  runTeardown () {
    const error = new TypeError('expected custom environment teardown failure')
    if (process.env.JEST_TEARDOWN_ERROR_MODE === 'sync') throw error
    if (process.env.JEST_TEARDOWN_ERROR_MODE === 'async') return Promise.reject(error)
    const result = super.teardown()
    if (process.env.JEST_TEARDOWN_ERROR_MODE === 'after-super') {
      return result.then(() => { throw error })
    }
    return result
  }
}

class FieldTeardownErrorEnvironment extends TeardownErrorEnvironment {
  teardown = () => this.runTeardown()

  /** @param {...unknown} args */
  constructor (...args) {
    super(...args)
    Object.preventExtensions(this)
  }
}

module.exports = process.env.JEST_TEARDOWN_DEFINITION === 'field'
  ? FieldTeardownErrorEnvironment
  : TeardownErrorEnvironment
