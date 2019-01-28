'use strict'

const proxyquire = require('proxyquire')
const benchmark = require('./benchmark')

const suite = benchmark('scope')

const spanStub = require('./stubs/span')

const hook = {
  enable () {},
  disable () {}
}

const ids = [0]

const asyncHooks = {
  executionAsyncId () {
    return ids[ids.length - 1]
  },
  createHook (hooks) {
    this.init = hooks.init
    this.destroy = hooks.destroy
    this.promiseResolve = hooks.promiseResolve

    this.before = asyncId => ids.push(asyncId)
    this.after = asyncId => ids.pop(asyncId)

    return hook
  }
}

const Scope = proxyquire('../src/scope/new/scope', {
  '../async_hooks': asyncHooks
})

const scope = new Scope()

suite
  .add('Scope', {
    fn () {
      scope.activate(spanStub, () => {
        asyncHooks.init(1)
      })

      asyncHooks.before(1)
      asyncHooks.after(1)
      asyncHooks.destroy(1)
    }
  })
  .add('Scope (nested)', {
    fn () {
      asyncHooks.init(1)
      asyncHooks.before(1)

      scope.activate(spanStub, () => {
        asyncHooks.init(2)
        asyncHooks.after(1)
        asyncHooks.destroy(1)
      })

      asyncHooks.before(2)

      scope.activate(spanStub, () => {
        asyncHooks.init(3)
        asyncHooks.after(2)
        asyncHooks.destroy(2)
      })

      asyncHooks.before(3)
      asyncHooks.after(3)
      asyncHooks.destroy(3)
    }
  })

suite.run()
