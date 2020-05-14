'use strict'

const { AsyncResource } = require('async_hooks')

const proxyquire = require('proxyquire')
const platform = require('../../packages/dd-trace/src/platform')
const node = require('../../packages/dd-trace/src/platform/node')
const benchmark = require('../benchmark')

platform.use(node)

const suite = benchmark('scope (AsyncLocalStorage)')

const spanStub = require('../stubs/span')

const Scope = proxyquire('../../packages/dd-trace/src/scope/async_local_storage', {
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

suite.run()
