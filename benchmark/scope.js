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

let fn
let promise
let emitter

suite
  .add('Scope#activate', {
    fn () {
      scope.activate(spanStub, () => {
        asyncHooks.init(1)
      })

      asyncHooks.before(1)
      asyncHooks.after(1)
      asyncHooks.destroy(1)
    }
  })
  .add('Scope#activate (nested)', {
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
  .add('Scope#active', {
    fn () {
      scope.active()
    }
  })
  .add('Scope#bind (null)', {
    fn () {
      scope.bind(null, {})
    }
  })
  .add('Scope#bind (fn)', {
    fn () {
      scope.bind(() => {}, {})
    }
  })
  .add('Scope#bind (fn())', {
    onStart () {
      fn = scope.bind(() => {}, {})
    },
    fn () {
      fn()
    }
  })
  .add('Scope#bind (promise)', {
    fn () {
      const promise = {
        then: () => {}
      }

      scope.bind(promise, {})
    }
  })
  .add('Scope#bind (promise.then)', {
    onStart () {
      promise = scope.bind({
        then: () => {}
      }, {})
    },
    fn () {
      promise.then(() => {})
    }
  })
  .add('Scope#bind (emitter)', {
    fn () {
      const emitter = {
        addListener: () => {},
        on: () => {},
        emit: () => {},
        removeListener: () => {}
      }

      scope.bind(emitter, {})
    }
  })
  .add('Scope#bind (emitter.on/off)', {
    onStart () {
      emitter = scope.bind({
        addListener: () => {},
        on: () => {},
        emit: () => {},
        removeListener: () => {},
        off: () => {}
      }, {})
    },
    fn () {
      const listener = () => {}

      emitter.on('test', listener)
      emitter.off('test', listener)
    }
  })

suite.run()
