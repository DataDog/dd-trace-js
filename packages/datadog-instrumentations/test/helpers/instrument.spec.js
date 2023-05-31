'use strict'

require('../../../dd-trace/test/setup/tap')

const { executionAsyncId } = require('async_hooks')
const { expect } = require('chai')
const { storage } = require('../../../datadog-core')
const { AsyncResource } = require('../../src/helpers/instrument')

describe('helpers/instrument', () => {
  describe('AsyncResource', () => {
    it('should bind statically', () => {
      storage.run('test1', () => {
        const tested = AsyncResource.bind(() => {
          expect(storage.getStore()).to.equal('test1')
        })

        storage.run('test2', () => {
          tested()
        })
      })
    })

    it('should bind with the right `this` value statically', () => {
      const self = 'test'

      const tested = AsyncResource.bind(function (a, b, c) {
        expect(this).to.equal(self)
        expect(test.asyncResource.asyncId()).to.equal(executionAsyncId())
        expect(test).to.have.length(3)
      }, 'test', self)

      tested()
    })

    it('should bind a specific instance', () => {
      storage.run('test1', () => {
        const asyncResource = new AsyncResource('test')

        storage.run('test2', () => {
          const tested = asyncResource.bind((a, b, c) => {
            expect(storage.getStore()).to.equal('test1')
            expect(test.asyncResource).to.equal(asyncResource)
            expect(test).to.have.length(3)
          })

          tested()
        })
      })
    })

    it('should bind with the right `this` value with an instance', () => {
      const self = 'test'

      const asyncResource = new AsyncResource('test')
      const tested = asyncResource.bind(function () {
        expect(this).to.equal(self)
      }, self)

      tested()
    })
  })
})
