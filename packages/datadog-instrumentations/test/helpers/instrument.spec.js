'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../../datadog-core')
const { AsyncResource, channel, createErrorPublisher } = require('../../src/helpers/instrument')

describe('helpers/instrument', () => {
  describe('createErrorPublisher', () => {
    it('drops a re-entrant publish through the same publisher', () => {
      const errorChannel = channel('apm:test:publish-error:same')
      const publishError = createErrorPublisher(errorChannel)
      let depth = 0
      const listener = () => {
        depth++
        if (depth > 10) return // a regressed guard fails the assert, not the runner
        publishError({ error: new Error('boom') })
      }

      errorChannel.subscribe(listener)
      try {
        publishError({ error: new Error('boom') })
      } finally {
        errorChannel.unsubscribe(listener)
      }

      assert.strictEqual(depth, 1)
    })

    it('still publishes a nested error through a different publisher', () => {
      const outerChannel = channel('apm:test:publish-error:outer')
      const innerChannel = channel('apm:test:publish-error:inner')
      const publishOuter = createErrorPublisher(outerChannel)
      const publishInner = createErrorPublisher(innerChannel)
      const innerListener = sinon.stub()
      // A subscriber on one framework's error channel synchronously drives a
      // different instrumented framework into its error path. A shared guard
      // would drop the inner publish; a per-publisher flag must not.
      const outerListener = () => {
        publishInner({ error: new Error('inner') })
      }

      outerChannel.subscribe(outerListener)
      innerChannel.subscribe(innerListener)
      try {
        publishOuter({ error: new Error('outer') })
      } finally {
        outerChannel.unsubscribe(outerListener)
        innerChannel.unsubscribe(innerListener)
      }

      sinon.assert.calledOnce(innerListener)
    })

    it('clears the guard so the same publisher publishes again afterwards', () => {
      const errorChannel = channel('apm:test:publish-error:reset')
      const publishError = createErrorPublisher(errorChannel)
      const listener = sinon.stub()

      errorChannel.subscribe(listener)
      try {
        publishError({ error: new Error('first') })
        publishError({ error: new Error('second') })
      } finally {
        errorChannel.unsubscribe(listener)
      }

      sinon.assert.calledTwice(listener)
    })

    it('republishes the same error object on each sequential publish', () => {
      // koa, router, connect and restify republish the one thrown error once per
      // unwound middleware layer so each layer's span gets tagged. The shared
      // publisher must not collapse those repeats by error identity - only the
      // synchronous re-entry above is dropped.
      const errorChannel = channel('apm:test:publish-error:same-object')
      const publishError = createErrorPublisher(errorChannel)
      const listener = sinon.stub()
      const error = new Error('boom')

      errorChannel.subscribe(listener)
      try {
        publishError({ error })
        publishError({ error })
        publishError({ error })
      } finally {
        errorChannel.unsubscribe(listener)
      }

      sinon.assert.calledThrice(listener)
    })
  })

  describe('AsyncResource', () => {
    it('should bind statically', () => {
      storage('legacy').run('test1', () => {
        const tested = AsyncResource.bind(() => {
          assert.strictEqual(storage('legacy').getStore(), 'test1')
        })

        storage('legacy').run('test2', () => {
          tested()
        })
      })
    })

    it('should bind with the right `this` value statically', () => {
      const self = 'test'

      const tested = AsyncResource.bind(function (a, b, c) {
        assert.strictEqual(this, self)
        assert.strictEqual(tested.length, 3)
      }, 'test', self)

      tested()
    })

    it('should bind a specific instance', () => {
      storage('legacy').run('test1', () => {
        const asyncResource = new AsyncResource('test')

        storage('legacy').run('test2', () => {
          const tested = asyncResource.bind((a, b, c) => {
            assert.strictEqual(storage('legacy').getStore(), 'test1')
            assert.strictEqual(tested.length, 3)
          })

          tested()
        })
      })
    })

    it('should bind with the right `this` value with an instance', () => {
      const self = 'test'

      const asyncResource = new AsyncResource('test')
      const tested = asyncResource.bind(function () {
        assert.strictEqual(this, self)
      }, self)

      tested()
    })
  })
})
