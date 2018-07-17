'use strict'

const proxyquire = require('proxyquire')
const benchmark = require('./benchmark')

const suite = benchmark('scope')

const spanStub = require('./stubs/span')

const hook = {
  enable () {},
  disable () {}
}

const asyncHooks = {
  createHook (hooks) {
    Object.keys(hooks).forEach(key => {
      this[key] = hooks[key]
    })

    return hook
  }
}

const ScopeManager = proxyquire('../src/scope/scope_manager', {
  './async_hooks': asyncHooks
})

const scopeManager = new ScopeManager()

suite
  .add('ScopeManager (sync)', {
    fn () {
      const scope = scopeManager.activate(spanStub)

      scope.close()
    }
  })
  .add('ScopeManager (async)', {
    fn () {
      asyncHooks.init(1)
      asyncHooks.before(1)

      const scope = scopeManager.activate(spanStub)

      scope.close()

      asyncHooks.after(1)
      asyncHooks.destroy(1)
    }
  })
  .add('ScopeManager (nested)', {
    fn () {
      asyncHooks.init(1)
      asyncHooks.before(1)

      const scope1 = scopeManager.activate(spanStub)

      asyncHooks.init(2)
      asyncHooks.after(1)
      asyncHooks.destroy(1)
      asyncHooks.before(2)

      scope1.close()

      const scope2 = scopeManager.activate(spanStub)

      asyncHooks.init(3)
      asyncHooks.after(2)
      asyncHooks.destroy(2)
      asyncHooks.before(3)

      scope2.close()

      asyncHooks.after(3)
      asyncHooks.destroy(3)
    }
  })

suite.run()
