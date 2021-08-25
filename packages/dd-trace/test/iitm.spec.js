'use strict'

const { expect } = require('chai')

describe('iitm.js', () => {
  const iitm = () => true
  let iitmjs

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

    it('should export an empty function', () => {
      expect(iitmjs).to.not.equal(iitm)
      expect(iitmjs()).to.be.undefined
    })
  })
})
