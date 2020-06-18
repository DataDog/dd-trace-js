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
})
