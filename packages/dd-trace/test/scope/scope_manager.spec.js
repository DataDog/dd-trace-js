'use strict'

const Scope = require('../../src/scope/noop/scope')

describe('ScopeManager', () => {
  let ScopeManager
  let scopeManager

  beforeEach(() => {
    ScopeManager = require('../../src/scope/scope_manager')

    scopeManager = new ScopeManager()
  })

  it('should be a singleton', () => {
    expect(new ScopeManager()).to.equal(scopeManager)
  })

  it('should support activating a span', () => {
    const span = {}

    scopeManager.activate(span)

    expect(scopeManager.active()).to.not.be.undefined
    expect(scopeManager.active()).to.be.instanceof(Scope)
    expect(scopeManager.active().span()).to.not.be.null
  })

  it('should support closing a scope', () => {
    const span = {}
    const scope = scopeManager.activate(span)

    scope.close()

    expect(scopeManager.active()).to.not.equal(scope)
  })

  it('should support automatically finishing the span on close', () => {
    const span = { finish: sinon.stub() }
    const scope = scopeManager.activate(span, true)

    scope.close()

    expect(span.finish).to.have.been.called
  })

  it('should always return a scope', () => {
    expect(scopeManager.active()).to.not.be.null
  })
})
