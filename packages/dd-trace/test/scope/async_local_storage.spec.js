'use strict'

const {
  AsyncLocalStorage,
  AsyncResource,
  executionAsyncId
} = require('async_hooks')
const Scope = require('../../src/scope/async_local_storage')
const Span = require('opentracing').Span
const testScope = require('./test')

wrapIt()

if (AsyncLocalStorage) {
  describe('Scope (AsyncLocalStorage)', test)
} else {
  describe.skip('Scope (AsyncLocalStorage)', test)
}

function test () {
  let scope
  let span

  beforeEach(() => {
    scope = new Scope()
    span = new Span()
  })

  it('should not break propagation for nested resources', done => {
    scope.activate(span, () => {
      const asyncResource = new AsyncResource(
        'TEST', { triggerAsyncId: executionAsyncId(), requireManualDestroy: false }
      )

      asyncResource.runInAsyncScope(() => {})

      expect(scope.active()).to.equal(span)

      // AsyncLocalStorage context persists through `done()` unless we tell it
      // not to. Without this, the following tests will run inside this scope.
      scope._storage.exit(done)
    })
  })

  testScope(() => scope)
}
