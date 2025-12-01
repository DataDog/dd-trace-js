'use strict'

const assert = require('node:assert/strict')
const { getVerbosity, getName, Verbosity, isDebugAllowed, isInfoAllowed } =
  require('../../../../src/appsec/iast/telemetry/verbosity')

describe('Telemetry Verbosity', () => {
  describe('getVerbosity', () => {
    beforeEach(() => {
      const path = require.resolve('../../../../src/appsec/iast/telemetry/verbosity')
      delete require.cache[path]
    })

    it('should get verbosity regardless of capitalization', () => {
      assert.strictEqual(getVerbosity('dEBug'), Verbosity.DEBUG)
    })

    it('should get verbosity default verbosity if invalid env var', () => {
      assert.strictEqual(getVerbosity('Invalid'), Verbosity.INFORMATION)
    })

    it('should get verbosity default verbosity if empty env var', () => {
      assert.strictEqual(getVerbosity(), Verbosity.INFORMATION)
    })
  })

  describe('getName and others', () => {
    it('should obtain name from verbosity', () => {
      assert.strictEqual(getName(Verbosity.DEBUG), 'DEBUG')
      assert.strictEqual(getName(Verbosity.INFORMATION), 'INFORMATION')
      assert.strictEqual(getName(Verbosity.MANDATORY), 'MANDATORY')
      assert.strictEqual(getName(Verbosity.OFF), 'OFF')
    })

    it('should handle debug verbosity level', () => {
      assert.strictEqual(isDebugAllowed(Verbosity.OFF), false)
      assert.strictEqual(isDebugAllowed(Verbosity.MANDATORY), false)
      assert.strictEqual(isDebugAllowed(Verbosity.INFORMATION), false)
      assert.strictEqual(isDebugAllowed(Verbosity.DEBUG), true)
    })

    it('should handle info verbosity level', () => {
      assert.strictEqual(isInfoAllowed(Verbosity.OFF), false)
      assert.strictEqual(isInfoAllowed(Verbosity.MANDATORY), false)
      assert.strictEqual(isInfoAllowed(Verbosity.INFORMATION), true)
      assert.strictEqual(isInfoAllowed(Verbosity.DEBUG), true)
    })
  })
})
