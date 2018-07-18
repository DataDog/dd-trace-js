'use strict'

const Scope = require('../../src/scope/scope')

describe('ScopeManager', () => {
  let ScopeManager
  let scopeManager
  let asyncHooks
  let hook

  beforeEach(() => {
    hook = {
      enable: sinon.stub(),
      disable: sinon.stub()
    }

    asyncHooks = {
      createHook (hooks) {
        Object.keys(hooks).forEach(key => {
          this[key] = hooks[key]
        })

        return hook
      }
    }

    ScopeManager = proxyquire('../src/scope/scope_manager', {
      './async_hooks': asyncHooks
    })

    scopeManager = new ScopeManager()
  })

  it('should be a singleton', () => {
    expect(new ScopeManager()).to.equal(scopeManager)
  })

  it('should enable its hooks', () => {
    expect(hook.enable).to.have.been.called
  })

  it('should support activating a span', () => {
    const span = {}

    scopeManager.activate(span)

    expect(scopeManager.active()).to.not.be.undefined
    expect(scopeManager.active()).to.be.instanceof(Scope)
    expect(scopeManager.active().span()).to.equal(span)
  })

  it('should support closing a scope', () => {
    const span = {}
    const scope = scopeManager.activate(span)

    scope.close()

    expect(scopeManager.active()).to.be.null
  })

  it('should support multiple simultaneous scopes', () => {
    const span1 = {}
    const span2 = {}
    const scope1 = scopeManager.activate(span1)

    expect(scopeManager.active()).to.equal(scope1)

    const scope2 = scopeManager.activate(span2)

    expect(scopeManager.active()).to.equal(scope2)

    scope2.close()

    expect(scopeManager.active()).to.equal(scope1)

    scope1.close()

    expect(scopeManager.active()).to.be.null
  })

  it('should support automatically finishing the span on close', () => {
    const span = { finish: sinon.stub() }
    const scope = scopeManager.activate(span, true)

    scope.close()

    expect(span.finish).to.have.been.called
  })

  it('should automatically close pending scopes when the context exits', () => {
    const span = {}

    asyncHooks.init(1)
    asyncHooks.before(1)

    const scope = scopeManager.activate(span)

    sinon.spy(scope, 'close')

    asyncHooks.after(1)

    expect(scope.close).to.have.been.called
  })

  it('should wait the end of the asynchronous context to close pending scopes', () => {
    const span = {}

    asyncHooks.init(1)
    asyncHooks.before(1)

    const scope = scopeManager.activate(span)

    sinon.spy(scope, 'close')

    asyncHooks.init(2)
    asyncHooks.after(1)
    asyncHooks.destroy(1)
    asyncHooks.before(2)

    expect(scope.close).to.not.have.been.called

    asyncHooks.init(3)
    asyncHooks.after(2)
    asyncHooks.destroy(2)
    asyncHooks.before(3)

    expect(scope.close).to.not.have.been.called

    asyncHooks.after(3)
    asyncHooks.destroy(3)

    expect(scope.close).to.have.been.called
  })

  it('should propagate parent context to children', () => {
    const span = {}
    const scope = scopeManager.activate(span)

    asyncHooks.init(1)
    asyncHooks.before(1)

    expect(scopeManager.active()).to.equal(scope)
  })

  it('should propagate parent context to descendants', () => {
    const scope1 = scopeManager.activate({})

    asyncHooks.init(1)
    asyncHooks.before(1)

    const scope2 = scopeManager.activate({})

    asyncHooks.init(2)
    asyncHooks.after(1)
    asyncHooks.destroy(1)
    asyncHooks.before(2)

    scope2.close()

    expect(scopeManager.active()).to.equal(scope1)
  })

  it('should isolate asynchronous contexts', () => {
    const span1 = {}
    const span2 = {}

    const scope1 = scopeManager.activate(span1)

    asyncHooks.init(1)
    asyncHooks.init(2)
    asyncHooks.before(1)

    scopeManager.activate(span2)

    asyncHooks.after(1)
    asyncHooks.before(2)

    expect(scopeManager.active()).to.equal(scope1)
  })

  it('should isolate reentering asynchronous contexts', () => {
    const span1 = {}
    const span2 = {}

    const scope1 = scopeManager.activate(span1)

    asyncHooks.init(1)
    asyncHooks.before(1)

    scopeManager.activate(span2)

    asyncHooks.after(1)
    asyncHooks.before(1)

    expect(scopeManager.active()).to.equal(scope1)

    asyncHooks.after(1)
  })

  it('should properly relink children of an exited context', () => {
    const scope1 = scopeManager.activate({})

    asyncHooks.init(1)
    asyncHooks.before(1)

    const scope2 = scopeManager.activate({})

    asyncHooks.init(2)
    asyncHooks.after(1)
    asyncHooks.before(2)

    scopeManager.activate({})
    scope2.close()

    asyncHooks.after(2)
    asyncHooks.before(2)

    expect(scopeManager.active()).to.equal(scope1)
  })

  it('should support reentering a context', () => {
    asyncHooks.init(1)

    asyncHooks.before(1)
    asyncHooks.init(2)
    asyncHooks.after(1)

    asyncHooks.before(1)
    asyncHooks.init(3)
    asyncHooks.after(1)

    asyncHooks.destroy(1)
    asyncHooks.destroy(2)
    asyncHooks.destroy(3)
  })

  it('should ignore unknown contexts', () => {
    expect(() => {
      asyncHooks.destroy(1)
      asyncHooks.after(1)
      asyncHooks.before(1)
    }).not.to.throw()
  })
})
