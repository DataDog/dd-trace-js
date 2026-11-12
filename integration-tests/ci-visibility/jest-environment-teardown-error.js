'use strict'

const assert = require('node:assert/strict')
const { setTimeout } = require('node:timers')

const { channel } = require('dc-polyfill')

const environment = require('jest-environment-node')
const NodeEnvironment = environment.TestEnvironment || environment
const finishedSuites = new Set()

channel('ci:jest:test-suite:finish').subscribe(({ testSuiteAbsolutePath }) => {
  finishedSuites.add(testSuiteAbsolutePath)
})
channel('ci:jest:test-suite:error').subscribe(({ errorMessage }) => {
  if (errorMessage?.includes('UNRELATED_POST_TEARDOWN_REFERENCE_ERROR')) {
    process.stderr.write('UNEXPECTED_LATE_SUITE_ERROR\n')
  }
})

function emitLateReferenceError () {
  setTimeout(() => setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error('UNRELATED_POST_TEARDOWN_REFERENCE_ERROR: Jest environment has been torn down')
  }, 0), 0)
}

class TeardownErrorEnvironment extends NodeEnvironment {
  /**
   * @param {object} config
   * @param {{ testPath: string }} context
   */
  constructor (config, context) {
    super(config, context)
    this.testPath = context.testPath
    finishedSuites.delete(this.testPath)
    const definition = process.env.JEST_TEARDOWN_DEFINITION
    if (definition === 'getter' || definition === 'accessor') {
      let teardown = () => this.runTeardown()
      Object.defineProperty(this, 'teardown', {
        configurable: true,
        get () { return teardown },
        set: definition === 'accessor'
          ? /** @param {() => unknown} value */ function (value) { teardown = value }
          : undefined,
      })
    }
    if (definition === 'constructor-decorator') this.decorateTeardown()
  }

  setup () {
    if (process.env.JEST_TEARDOWN_DEFINITION === 'setup-decorator') this.decorateTeardown()
    if (process.env.JEST_TEARDOWN_DEFINITION === 'accessor') {
      const teardown = this.teardown
      this.teardown = () => teardown.call(this)
    }
    const result = super.setup()
    Object.preventExtensions(this)
    return result
  }

  decorateTeardown () {
    const teardown = this.teardown
    this.teardown = () => teardown.call(this).finally(() => {
      assert.strictEqual(finishedSuites.has(this.testPath), false, 'Suite finished before custom teardown cleanup')
    })
  }

  teardown () {
    return this.runTeardown()
  }

  runTeardown () {
    const error = new TypeError('expected custom environment teardown failure')
    if (process.env.JEST_TEARDOWN_ERROR_MODE === 'sync') throw error
    if (process.env.JEST_TEARDOWN_ERROR_MODE === 'async') return Promise.reject(error)
    const result = super.teardown()
    if (process.env.JEST_TEARDOWN_ERROR_MODE === 'sync-after-super') {
      emitLateReferenceError()
      throw error
    }
    if (process.env.JEST_TEARDOWN_ERROR_MODE === 'after-super') {
      return result.then(() => { throw error })
    }
    return result
  }
}

class FieldTeardownErrorEnvironment extends TeardownErrorEnvironment {
  teardown = () => this.runTeardown()
}

module.exports = process.env.JEST_TEARDOWN_DEFINITION === 'field'
  ? FieldTeardownErrorEnvironment
  : TeardownErrorEnvironment
