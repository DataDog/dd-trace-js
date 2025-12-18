'use strict'

const assert = require('node:assert/strict')

const { describe, it, before, after } = require('mocha')
const sinon = require('sinon')
const dc = require('dc-polyfill')
const proxyquire = require('proxyquire')

require('./setup/core')

describe('iitm.js', () => {
  let hookFn
  const iitm = {
    addHook: (fn) => {
      hookFn = fn
    }
  }
  let iitmjs

  describe('with a supported Node.js version', () => {
    let listener
    const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')

    before(() => {
      listener = sinon.stub()
      iitmjs = proxyquire('../src/iitm', {
        'import-in-the-middle': iitm
      })
    })

    it('should export iitm', () => {
      assert.strictEqual(iitmjs, iitm)
    })

    it('should publish in channel hook trigger', () => {
      moduleLoadStartChannel.subscribe(listener)
      hookFn('moduleName', 'moduleNs')
      sinon.assert.calledOnce(listener)
    })

    after(() => {
      const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
      moduleLoadStartChannel.unsubscribe(listener)
    })
  })
})
