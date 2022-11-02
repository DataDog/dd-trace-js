'use strict'

describe('IAST TaintTrackingFilter', () => {
  let filter

  describe('isPrivateModule', () => {
    beforeEach(() => {
      filter = require('../../../src/appsec/iast/taint-tracking/filter')
    })

    afterEach(sinon.restore)

    it('Filename outside node_modules is private', () => {
      const filename = 'test.js'
      expect(filter.isPrivateModule(filename)).to.be.true
    })

    it('Filename inside node_modules is not private', () => {
      const filename = 'node_modules/test-package/test.js'
      expect(filter.isPrivateModule(filename)).to.be.false
    })
  })
})
