'use strict'

const { AsyncResource } = require('async_hooks')
const EventEmitter = require('events')
const { ServerResponse } = require('http')

const benchmark = require('../benchmark')

const suite = benchmark('scope (async_hooks)')

const spanStub = require('../stubs/span')

const Scope = require('../../packages/dd-trace/src/scope/async_hooks')

// This is also done in the `http` plugin.
Scope._wrapEmitter(ServerResponse.prototype)

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
  .add('Scope#activate (promise)', {
    defer: true,
    fn (deferred) {
      scope.activate(spanStub, () => {
        Promise.resolve().then(() => {
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
  .add('Scope#bind (wrap emitter instance)', {
    fn () {
      emitter = Object.create(EventEmitter.prototype)

      scope.bind(emitter, {})
    }
  })
  .add('Scope#bind (wrap emitter instance .on/off)', {
    onStart () {
      emitter = scope.bind(Object.create(EventEmitter.prototype), {})
    },
    fn () {
      const listener = () => {}

      emitter.on('test', listener)
      emitter.off('test', listener)
    }
  })
  .add('Scope#bind (wrap emitter prototype)', {
    fn () {
      emitter = Object.create(ServerResponse.prototype)

      scope.bind(emitter, {})
    }
  })
  .add('Scope#bind (wrap emitter prototype .on/off)', {
    onStart () {
      emitter = scope.bind(Object.create(ServerResponse.prototype), {})
    },
    fn () {
      const listener = () => {}

      emitter.on('test', listener)
      emitter.off('test', listener)
    }
  })

suite.run()
