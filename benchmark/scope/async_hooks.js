'use strict'

const { AsyncResource } = require('async_hooks')

const proxyquire = require('proxyquire')
const platform = require('../../packages/dd-trace/src/platform')
const node = require('../../packages/dd-trace/src/platform/node')
const benchmark = require('../benchmark')

platform.use(node)

const suite = benchmark('scope (async_hooks)')

const spanStub = require('../stubs/span')

const Scope = proxyquire('../../packages/dd-trace/src/scope/async_hooks', {
  '../platform': platform
})

const scope = new Scope({
  experimental: {}
})

function activateResource (name) {
  return scope.activate(spanStub, () => {
    return new AsyncResource(name, {
      requireManualDestroy: true
    })
  })
}

let fn
let promise
let emitter

suite
  .add('Scope#activate', {
    fn () {
      const resource = activateResource('test')
      resource.runInAsyncScope(() => {})
      resource.emitDestroy()
    }
  })
  .add('Scope#activate (nested)', {
    fn () {
      const outer = activateResource('outer')
      let middle
      let inner

      outer.runInAsyncScope(() => {
        middle = activateResource('middle')
      })
      outer.emitDestroy()

      middle.runInAsyncScope(() => {
        inner = activateResource('middle')
      })
      middle.emitDestroy()

      inner.runInAsyncScope(() => {})
      inner.emitDestroy()
    }
  })
  .add('Scope#activate (async)', {
    defer: true,
    fn (deferred) {
      scope.activate(spanStub, () => {
        queueMicrotask(() => {
          deferred.resolve()
        })
      })
    }
  })
  .add('Scope#activate (async/await)', {
    defer: true,
    async fn (deferred) {
      await scope.activate(spanStub, () => {
        return Promise.resolve()
      })
      deferred.resolve()
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
