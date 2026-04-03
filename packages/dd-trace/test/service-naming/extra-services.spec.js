'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')

require('../setup/core')
const { registerExtraService, getExtraServices, clear } = require('../../src/service-naming/extra-services')

describe('Extra services', () => {
  beforeEach(clear)

  describe('registerExtraService', () => {
    it('should register defined service names', () => {
      registerExtraService('service-test')

      assert.deepStrictEqual(getExtraServices(), ['service-test'])
    })

    it('should not register invalid service names', () => {
      registerExtraService()
      registerExtraService(null)
      registerExtraService('')

      assert.strictEqual(getExtraServices().length, 0)
    })

    it('should register the same service name only once', () => {
      registerExtraService('service-test')
      registerExtraService('service-test')
      registerExtraService('service-test')

      const extraServices = getExtraServices()
      assert.strictEqual(extraServices.length, 1)
      assert.deepStrictEqual(extraServices, ['service-test'])
    })

    it('should register a max of 64 service names', () => {
      for (let i = 0; i < 100; i++) {
        registerExtraService(`service-test-${i}`)
      }

      assert.strictEqual(getExtraServices().length, 64)
    })
  })
})
