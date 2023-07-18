'use strict'

const { expect } = require('chai')
const { getVerbosity, getName, Verbosity, isDebugAllowed, isInfoAllowed } =
  require('../../../../src/appsec/iast/telemetry/verbosity')

describe('Telemetry Verbosity', () => {
  describe('getVerbosity', () => {
    beforeEach(() => {
      const path = require.resolve('../../../../src/appsec/iast/telemetry/verbosity')
      delete require.cache[path]
    })

    it('should get verbosity regardless of capitalization', () => {
      expect(getVerbosity('dEBug')).to.be.eq(Verbosity.DEBUG)
    })

    it('should get verbosity default verbosity if invalid env var', () => {
      expect(getVerbosity('Invalid')).to.be.eq(Verbosity.INFORMATION)
    })

    it('should get verbosity default verbosity if empty env var', () => {
      expect(getVerbosity()).to.be.eq(Verbosity.INFORMATION)
    })
  })

  describe('getName and others', () => {
    it('should obtain name from verbosity', () => {
      expect(getName(Verbosity.DEBUG)).to.be.equal('DEBUG')
      expect(getName(Verbosity.INFORMATION)).to.be.equal('INFORMATION')
      expect(getName(Verbosity.MANDATORY)).to.be.equal('MANDATORY')
      expect(getName(Verbosity.OFF)).to.be.equal('OFF')
    })

    it('should handle debug verbosity level', () => {
      expect(isDebugAllowed(Verbosity.OFF)).to.be.false
      expect(isDebugAllowed(Verbosity.MANDATORY)).to.be.false
      expect(isDebugAllowed(Verbosity.INFORMATION)).to.be.false
      expect(isDebugAllowed(Verbosity.DEBUG)).to.be.true
    })

    it('should handle info verbosity level', () => {
      expect(isInfoAllowed(Verbosity.OFF)).to.be.false
      expect(isInfoAllowed(Verbosity.MANDATORY)).to.be.false
      expect(isInfoAllowed(Verbosity.INFORMATION)).to.be.true
      expect(isInfoAllowed(Verbosity.DEBUG)).to.be.true
    })
  })
})
