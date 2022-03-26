'use strict'

const { expect } = require('chai')
const semver = require('semver')

describe('iitm.js', () => {
  const iitm = () => true
  let iitmjs

  if (semver.satisfies(process.versions.node, '^12.20.0 || >=14.13.1')) {
    context('with a supported nodejs version', () => {
      before(() => {
        iitmjs = proxyquire('../src/iitm', {
          'import-in-the-middle': iitm
        })
      })

      it('should export iitm', () => {
        expect(iitmjs).to.equal(iitm)
        expect(iitmjs()).to.be.true
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
