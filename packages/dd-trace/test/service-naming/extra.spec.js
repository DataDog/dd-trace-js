'use strict'

require('../setup/tap')

const { expect } = require('chai')
const { registerService, getExtraServices, clear } = require('../../src/service-naming/extra')

describe('Extra services', () => {
  beforeEach(clear)

  describe('registerService', () => {
    it('should register defined service names', () => {
      registerService('service-test')

      expect(getExtraServices()).to.deep.equal(['service-test'])
    })

    it('should not register invalid service names', () => {
      registerService()
      registerService(null)
      registerService('')

      expect(getExtraServices().length).to.equal(0)
    })

    it('should register the same service name only once', () => {
      registerService('service-test')
      registerService('service-test')
      registerService('service-test')

      const extraServices = getExtraServices()
      expect(extraServices.length).to.equal(1)
      expect(extraServices).to.deep.equal(['service-test'])
    })

    it('should register a max of 64 service names', () => {
      for (let i = 0; i < 100; i++) {
        registerService(`service-test-${i}`)
      }

      expect(getExtraServices().length).to.equal(64)
    })

    it('should register automatically service names defined in DD_EXTRA_SERVICES env var', () => {
      const originalExtraServices = process.env.DD_EXTRA_SERVICES

      delete require.cache[require.resolve('../../src/service-naming/extra')]

      process.env.DD_EXTRA_SERVICES = 'service1,   service2, service3   ,, '

      const { getExtraServices } = require('../../src/service-naming/extra')

      expect(getExtraServices()).to.deep.equal(['service1', 'service2', 'service3'])

      process.env.DD_EXTRA_SERVICES = originalExtraServices
    })
  })
})
