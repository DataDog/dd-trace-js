'use strict'

const Scope = require('../../src/scope/base')

wrapIt()

describe('Scope (base)', () => {
  let scope

  beforeEach(() => {
    scope = new Scope({
      experimental: {}
    })
  })

  it('should be a no-op when activating', done => {
    scope.activate({}, () => {
      expect(scope.active()).to.be.null
      done()
    })
  })
})
