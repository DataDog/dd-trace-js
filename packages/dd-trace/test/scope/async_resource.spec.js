'use strict'

const {
  AsyncResource,
  executionAsyncId
} = require('async_hooks')
const Scope = require('../../src/scope/async_resource')
const Span = require('opentracing').Span
const semver = require('semver')
const testScope = require('./test')

wrapIt()

// https://github.com/nodejs/node/commit/52d8afc07e005343390ebc8c6d9e1eec77acd16e#diff-0bb01a51b135a5f68d93540808bac801
if (semver.satisfies(process.version, '^12.17.0 || >=13.14.0')) {
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

  afterEach(() => {
    scope.disable()
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
