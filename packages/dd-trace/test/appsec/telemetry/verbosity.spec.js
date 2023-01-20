'use strict'

const { expect } = require('chai')

describe('Telemetry Verbosity', () => {
  describe('getVerbosity', () => {
    beforeEach(() => {
      const path = require.resolve('../../../src/appsec/telemetry/verbosity')
      delete require.cache[path]
    })

    it('should get verbosity from env var', () => {
      const verbosityValue = process.env.DD_IAST_TELEMETRY_VERBOSITY
      process.env.DD_IAST_TELEMETRY_VERBOSITY = 'Debug'

      const verbosity = require('../../../src/appsec/telemetry/verbosity')
      expect(verbosity.getVerbosity()).to.be.eq(verbosity.Verbosity.DEBUG)

      process.env.DD_IAST_TELEMETRY_VERBOSITY = verbosityValue
    })

    it('should get verbosity default verbosity if invalid env var', () => {
      const verbosity = require('../../../src/appsec/telemetry/verbosity')
      expect(verbosity.getVerbosity('Invalid')).to.be.eq(verbosity.Verbosity.INFORMATION)
    })

    it('should get verbosity default verbosity if empty env var', () => {
      const verbosity = require('../../../src/appsec/telemetry/verbosity')
      expect(verbosity.getVerbosity()).to.be.eq(verbosity.Verbosity.INFORMATION)
    })
  })

  describe('getName and others', () => {
    const { getName, Verbosity, isDebugAllowed, isInfoAllowed } = require('../../../src/appsec/telemetry/verbosity')

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
