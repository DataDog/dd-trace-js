'use strict'

const { expect } = require('chai')
const { describe, it } = require('mocha')

const { executionAsyncId } = require('node:async_hooks')

const { storage } = require('../../../datadog-core')
const { AsyncResource } = require('../../src/helpers/instrument')

describe('helpers/instrument', () => {
  describe('AsyncResource', () => {
    it('should bind statically', () => {
      storage('legacy').run('test1', () => {
        const tested = AsyncResource.bind(() => {
          expect(storage('legacy').getStore()).to.equal('test1')
        })

        storage('legacy').run('test2', () => {
          tested()
        })
      })
    })

    it('should bind with the right `this` value statically', () => {
      const self = 'test'

      const tested = AsyncResource.bind(function (a, b, c) {
        expect(this).to.equal(self)
        expect(tested.asyncResource.asyncId()).to.equal(executionAsyncId())
        expect(tested).to.have.length(3)
      }, 'test', self)

      tested()
    })

    it('should bind a specific instance', () => {
      storage('legacy').run('test1', () => {
        const asyncResource = new AsyncResource('test')

        storage('legacy').run('test2', () => {
          const tested = asyncResource.bind((a, b, c) => {
            expect(storage('legacy').getStore()).to.equal('test1')
            expect(tested.asyncResource).to.equal(asyncResource)
            expect(tested).to.have.length(3)
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
