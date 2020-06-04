'use strict'

'use strict'

const expect = require('chai').expect

describe('util', () => {
  let util

  beforeEach(() => {
    util = require('../../src/profiling/util')
  })

  describe('maybeRequire', () => {
    it('should require available modules', () => {
      expect(util.maybeRequire('mocha')).to.be.a('function')
    })

    it('should handle the error for unavailable modules', () => {
      expect(util.maybeRequire('_invalid_')).to.be.null
    })
  })

  describe('coalesce', () => {
    it('should return the first defined non-null value', () => {
      expect(util.coalesce(null, false)).to.be.false
      expect(util.coalesce(undefined, 'test')).to.equal('test')
      expect(util.coalesce(0, 'test')).to.equal(0)
    })
  })
})
