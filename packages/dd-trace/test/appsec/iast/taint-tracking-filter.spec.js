'use strict'
const { expect } = require('chai')
const fs = require('fs')
const sinon = require('sinon')

describe('IAST TaintTrackingFilter', () => {
  let filter

  describe('isPrivateModule', () => {
    beforeEach(() => {
      sinon.stub(fs, 'existsSync').returns((filepath) => {
        return filepath === 'node_modules/test-package/package.json'
      });
      filter = require('../../../src/appsec/iast/taint-tracking-filter')
    })

    afterEach(sinon.restore)

    it('Filename outside node_modules is private', () => {
      const filename = 'test.js'
      expect(filter.isPrivateModule(filename)).to.be.true
    })

    it('Filename inside node_modules and module with registry different from npm is private', () => {
      sinon.stub(fs, 'readFileSync').returns('{"publishConfig":{"registry":"my_registry.test.com"}}');
      const filename = 'node_modules/test-package/test.js'
      expect(filter.isPrivateModule(filename)).to.be.true
    })

    it('Filename inside node_modules and module without registry is not private', () => {
      sinon.stub(fs, 'readFileSync').returns('{}');
      const filename = 'node_modules/test-package/test.js'
      expect(filter.isPrivateModule(filename)).to.be.false
    })

    it('Filename inside node_modules and module with npm registry is not private', () => {
      sinon.stub(fs, 'readFileSync').returns('{"publishConfig":{"registry":"registry.npmjs.org"}}');
      const filename = 'node_modules/test-package/test.js'
      expect(filter.isPrivateModule(filename)).to.be.false
    })
  })
})