'use strict'

require('./setup/tap')

const { expect } = require('chai')
const semver = require('semver')
const dc = require('diagnostics_channel')

describe('iitm.js', () => {
  let hookFn
  const iitm = {
    addHook: (fn) => {
      hookFn = fn
    }
  }
  let iitmjs

  if (semver.satisfies(process.versions.node, '>=14.13.1')) {
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
  }

  context('with an unsupported nodejs version', () => {
    let desc
    before(() => {
      desc = Object.getOwnPropertyDescriptor(process.versions, 'node')
      Object.defineProperty(process.versions, 'node', Object.assign({}, desc, { value: '10.0.0' }))
      iitmjs = proxyquire('../src/iitm', {
        'import-in-the-middle': iitm
      })
    })
    after(() => {
      Object.defineProperty(process.versions, 'node', desc)
    })

    it('should export a noop hook', () => {
      expect(iitmjs).to.not.equal(iitm)

      const hook = iitmjs()

      expect(() => hook.unhook()).to.not.throw()
      expect(() => iitmjs.addHook()).to.not.throw()
      expect(() => iitmjs.removeHook()).to.not.throw()
    })
  })
})
