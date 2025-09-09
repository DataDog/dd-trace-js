'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha

require('../setup/core')

const { registerExtraService, getExtraServices, clear } = require('../../src/service-naming/extra-services')

describe('Extra services', () => {
  beforeEach(clear)

  describe('registerExtraService', () => {
    it('should register defined service names', () => {
      registerExtraService('service-test')

      expect(getExtraServices()).to.deep.equal(['service-test'])
    })

    it('should not register invalid service names', () => {
      registerExtraService()
      registerExtraService(null)
      registerExtraService('')

      expect(getExtraServices().length).to.equal(0)
    })

    it('should register the same service name only once', () => {
      registerExtraService('service-test')
      registerExtraService('service-test')
      registerExtraService('service-test')

      const extraServices = getExtraServices()
      expect(extraServices.length).to.equal(1)
      expect(extraServices).to.deep.equal(['service-test'])
    })

    it('should register a max of 64 service names', () => {
      for (let i = 0; i < 100; i++) {
        registerExtraService(`service-test-${i}`)
      }

      expect(getExtraServices().length).to.equal(64)
    })
  })
})
