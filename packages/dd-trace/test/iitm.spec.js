'use strict'

require('./setup/tap')

const { expect } = require('chai')
const dc = require('dc-polyfill')

describe('iitm.js', () => {
  let hookFn
  const iitm = {
    addHook: (fn) => {
      hookFn = fn
    }
  }
  let iitmjs

  context('with a supported nodejs version', () => {
    let listener
    const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
    before(() => {
      listener = sinon.stub()
      iitmjs = proxyquire('../src/iitm', {
        'import-in-the-middle': iitm
      })
    })

    it('should export iitm', () => {
      expect(iitmjs).to.equal(iitm)
    })

    it('should publish in channel hook trigger', () => {
      moduleLoadStartChannel.subscribe(listener)
      hookFn('moduleName', 'moduleNs')
      expect(listener).to.have.been.calledOnce
    })

    after(() => {
      const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
      moduleLoadStartChannel.unsubscribe(listener)
    })
  })
})
