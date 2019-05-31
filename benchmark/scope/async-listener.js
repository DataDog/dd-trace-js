'use strict'

const proxyquire = require('proxyquire')
const benchmark = require('../benchmark')

const suite = benchmark('scope')

const spanStub = require('../stubs/span')

const asyncListener = {
  addAsyncListener (hooks) {
    this.create = hooks.create
    this.before = hooks.before
    this.after = hooks.after
    this.error = hooks.error

    return this
  }
}

const Scope = proxyquire('../../src/scope/async-listener', {
  '@datadog/async-listener': asyncListener
})

const scope = new Scope()
const context = {}

let fn
let promise
let emitter

suite
  .add('Scope#activate', {
    fn () {
      scope.activate(spanStub, () => {
        asyncListener.create(spanStub)
      })

      asyncListener.before(context, spanStub)
      asyncListener.after(context, spanStub)
    }
  })
  .add('Scope#activate (nested)', {
    fn () {
      asyncListener.create(spanStub)
      asyncListener.before(context, spanStub)

      scope.activate(spanStub, () => {
        asyncListener.create(spanStub)
        asyncListener.after(context, spanStub)
      })

      asyncListener.before(context, spanStub)

      scope.activate(spanStub, () => {
        asyncListener.create(spanStub)
        asyncListener.after(context, spanStub)
      })

      asyncListener.before(context, spanStub)
      asyncListener.after(context, spanStub)
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
