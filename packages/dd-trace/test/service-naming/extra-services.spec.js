'use strict'

const t = require('tap')
require('../setup/core')

const { expect } = require('chai')
const { registerExtraService, getExtraServices, clear } = require('../../src/service-naming/extra-services')

t.test('Extra services', t => {
  t.beforeEach(clear)

  t.test('registerExtraService', t => {
    t.test('should register defined service names', t => {
      registerExtraService('service-test')

      expect(getExtraServices()).to.deep.equal(['service-test'])
      t.end()
    })

    t.test('should not register invalid service names', t => {
      registerExtraService()
      registerExtraService(null)
      registerExtraService('')

      expect(getExtraServices().length).to.equal(0)
      t.end()
    })

    t.test('should register the same service name only once', t => {
      registerExtraService('service-test')
      registerExtraService('service-test')
      registerExtraService('service-test')

      const extraServices = getExtraServices()
      expect(extraServices.length).to.equal(1)
      expect(extraServices).to.deep.equal(['service-test'])
      t.end()
    })

    t.test('should register a max of 64 service names', t => {
      for (let i = 0; i < 100; i++) {
        registerExtraService(`service-test-${i}`)
      }

      expect(getExtraServices().length).to.equal(64)
      t.end()
    })
    t.end()
  })
  t.end()
})
