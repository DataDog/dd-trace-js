'use strict'

const {
  AsyncResource,
  executionAsyncId
} = require('async_hooks')
const Scope = require('../../src/scope/async_resource')
const Span = require('opentracing').Span
const semver = require('semver')
const testScope = require('./test')

wrapIt('async_resource')

// https:// nodejs.org/api/async_hooks.html#async_hooks_async_hooks_executionasyncresource
if (semver.satisfies(process.version, '^12.17.0 || >=13.9.0')) {
  describe('Scope (executionAsyncResource)', test)
} else {
  describe.skip('Scope (executionAsyncResource)', test)
}

function test () {
  let scope
  let span

  beforeEach(() => {
    scope = new Scope()
    span = new Span()
  })

  it('should not break propagation for nested resources', () => {
    scope.activate(span, () => {
      const asyncResource = new AsyncResource(
        'TEST', { triggerAsyncId: executionAsyncId(), requireManualDestroy: false }
      )

      asyncResource.runInAsyncScope(() => {})

      expect(scope.active()).to.equal(span)
    })
  })

  testScope(() => scope)
}
