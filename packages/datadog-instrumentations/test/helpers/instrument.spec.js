'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { storage } = require('../../../datadog-core')
const { AsyncResource } = require('../../src/helpers/instrument')
describe('helpers/instrument', () => {
  describe('AsyncResource', () => {
    it('should bind statically', () => {
      storage('legacy').run('test1', () => {
        const tested = AsyncResource.bind(() => {
          assert.strictEqual(storage('legacy').getStore(), 'test1')
        })

        storage('legacy').run('test2', () => {
          tested()
        })
      })
    })

    it('should bind with the right `this` value statically', () => {
      const self = 'test'

      const tested = AsyncResource.bind(function (a, b, c) {
        assert.strictEqual(this, self)
        assert.strictEqual(tested.length, 3)
      }, 'test', self)

      tested()
    })

    it('should bind a specific instance', () => {
      storage('legacy').run('test1', () => {
        const asyncResource = new AsyncResource('test')

        storage('legacy').run('test2', () => {
          const tested = asyncResource.bind((a, b, c) => {
            assert.strictEqual(storage('legacy').getStore(), 'test1')
            assert.strictEqual(tested.length, 3)
          })

          tested()
        })
      })
    })

    it('should bind with the right `this` value with an instance', () => {
      const self = 'test'

      const asyncResource = new AsyncResource('test')
      const tested = asyncResource.bind(function () {
        assert.strictEqual(this, self)
      }, self)

      tested()
    })
  })
})
