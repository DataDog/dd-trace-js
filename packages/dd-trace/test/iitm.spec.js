'use strict'

const t = require('tap')
require('./setup/core')

const { expect } = require('chai')
const dc = require('dc-polyfill')

t.test('iitm.js', t => {
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
    t.before(() => {
      listener = sinon.stub()
      iitmjs = proxyquire('../src/iitm', {
        'import-in-the-middle': iitm
      })
    })

    t.test('should export iitm', t => {
      expect(iitmjs).to.equal(iitm)
      t.end()
    })

    t.test('should publish in channel hook trigger', t => {
      moduleLoadStartChannel.subscribe(listener)
      hookFn('moduleName', 'moduleNs')
      expect(listener).to.have.been.calledOnce
      t.end()
    })

    t.after(() => {
      const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
      moduleLoadStartChannel.unsubscribe(listener)
    })
  })
  t.end()
})
