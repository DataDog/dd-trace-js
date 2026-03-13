'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
const {
  promisifiedHandler,
  tagObject,
  isBatchItemFailure,
  batchItemFailureCount,
  HANDLER_STREAMING,
  STREAM_RESPONSE,
} = require('../src/handler-utils')

describe('handler-utils', () => {
  describe('promisifiedHandler', () => {
    it('wraps a callback-style handler and resolves on success', () => {
      function handler (event, context, callback) {
        callback(null, { statusCode: 200 })
      }

      const wrapped = promisifiedHandler(handler)
      const context = { callbackWaitsForEmptyEventLoop: true }

      return wrapped({}, context).then(function (result) {
        assert.deepEqual(result, { statusCode: 200 })
      })
    })

    it('wraps a callback-style handler and rejects on error', () => {
      function handler (event, context, callback) {
        callback(new Error('fail'))
      }

      const wrapped = promisifiedHandler(handler)
      const context = { callbackWaitsForEmptyEventLoop: true }

      return wrapped({}, context).then(
        function () { assert.fail('should have rejected') },
        function (err) { assert.equal(err.message, 'fail') }
      )
    })

    it('wraps a promise-style handler', () => {
      function handler (event, context) {
        return Promise.resolve({ statusCode: 201 })
      }

      const wrapped = promisifiedHandler(handler)
      const context = { callbackWaitsForEmptyEventLoop: true }

      return wrapped({}, context).then(function (result) {
        assert.deepEqual(result, { statusCode: 201 })
      })
    })

    it('wraps a sync handler returning a plain value', () => {
      function handler (event, context) {
        return { statusCode: 204 }
      }

      const wrapped = promisifiedHandler(handler)
      const context = { callbackWaitsForEmptyEventLoop: true }

      return wrapped({}, context).then(function (result) {
        assert.deepEqual(result, { statusCode: 204 })
      })
    })

    it('wraps a legacy context.done handler', () => {
      function handler (event, context) {
        context.done(null, { statusCode: 200 })
      }
      const wrapped = promisifiedHandler(handler)
      const context = { callbackWaitsForEmptyEventLoop: true }

      return wrapped({}, context).then(function (result) {
        assert.deepEqual(result, { statusCode: 200 })
      })
    })

    it('wraps a legacy context.done handler with error', () => {
      function handler (event, context) {
        context.done(new Error('legacy fail'))
      }

      const wrapped = promisifiedHandler(handler)
      const context = { callbackWaitsForEmptyEventLoop: true }

      return wrapped({}, context).then(
        function () { assert.fail('should have rejected') },
        function (err) { assert.equal(err.message, 'legacy fail') }
      )
    })

    it('wraps a legacy context.succeed handler', () => {
      function handler (event, context) {
        context.succeed({ body: 'ok' })
      }

      const wrapped = promisifiedHandler(handler)
      const context = { callbackWaitsForEmptyEventLoop: true }

      return wrapped({}, context).then(function (result) {
        assert.deepEqual(result, { body: 'ok' })
      })
    })

    it('wraps a legacy context.fail handler', () => {
      function handler (event, context) {
        context.fail(new Error('legacy error'))
      }

      const wrapped = promisifiedHandler(handler)
      const context = { callbackWaitsForEmptyEventLoop: true }

      return wrapped({}, context).then(
        function () { assert.fail('should have rejected') },
        function (err) { assert.equal(err.message, 'legacy error') }
      )
    })

    it('passes through streaming handlers', () => {
      function handler (event, responseStream, context) {
        return Promise.resolve('streamed')
      }
      handler[HANDLER_STREAMING] = STREAM_RESPONSE

      const wrapped = promisifiedHandler(handler)
      return wrapped({}, {}, {}).then(function (result) {
        assert.equal(result, 'streamed')
      })
    })
  })

  describe('tagObject', () => {
    it('tags a simple string value', () => {
      const tags = {}
      const span = { setTag: function (k, v) { tags[k] = v } }
      tagObject(span, 'request.body', 'hello')
      assert.equal(tags['request.body'], 'hello')
    })

    it('tags a number value', () => {
      const tags = {}
      const span = { setTag: function (k, v) { tags[k] = v } }
      tagObject(span, 'request.count', 42)
      assert.equal(tags['request.count'], '42')
    })

    it('tags a boolean value', () => {
      const tags = {}
      const span = { setTag: function (k, v) { tags[k] = v } }
      tagObject(span, 'request.flag', true)
      assert.equal(tags['request.flag'], 'true')
    })

    it('tags null value directly', () => {
      const tags = {}
      const span = { setTag: function (k, v) { tags[k] = v } }
      tagObject(span, 'request.data', null)
      assert.equal(tags['request.data'], null)
    })

    it('recurses into objects', () => {
      const tags = {}
      const span = { setTag: function (k, v) { tags[k] = v } }
      tagObject(span, 'req', { method: 'GET', path: '/api' })
      assert.equal(tags['req.method'], 'GET')
      assert.equal(tags['req.path'], '/api')
    })

    it('parses JSON strings and recurses', () => {
      const tags = {}
      const span = { setTag: function (k, v) { tags[k] = v } }
      tagObject(span, 'body', '{"key":"value"}')
      assert.equal(tags['body.key'], 'value')
    })

    it('stops at maxDepth and serializes to JSON', () => {
      const tags = {}
      const span = { setTag: function (k, v) { tags[k] = v } }
      tagObject(span, 'deep', { a: 'b' }, 0, 1)
      assert.equal(tags['deep'], '{"a":"b"}')
    })

    it('redacts sensitive keys', () => {
      const tags = {}
      const span = { setTag: function (k, v) { tags[k] = v } }
      tagObject(span, 'headers.authorization', 'Bearer secret')
      assert.equal(tags['headers.authorization'], 'redacted')
    })

    it('redacts password keys', () => {
      const tags = {}
      const span = { setTag: function (k, v) { tags[k] = v } }
      tagObject(span, 'config.password', 'mysecret')
      assert.equal(tags['config.password'], 'redacted')
    })
  })

  describe('isBatchItemFailure', () => {
    it('returns true for valid batch item failure response', () => {
      assert.equal(isBatchItemFailure({ batchItemFailures: [{ itemIdentifier: '123' }] }), true)
    })

    it('returns true for empty batch item failures array', () => {
      assert.equal(isBatchItemFailure({ batchItemFailures: [] }), true)
    })

    it('returns false for null', () => {
      assert.equal(isBatchItemFailure(null), false)
    })

    it('returns false for undefined', () => {
      assert.equal(isBatchItemFailure(undefined), false)
    })

    it('returns false for object without batchItemFailures', () => {
      assert.equal(isBatchItemFailure({ statusCode: 200 }), false)
    })

    it('returns false for non-array batchItemFailures', () => {
      assert.equal(isBatchItemFailure({ batchItemFailures: 'not-array' }), false)
    })
  })

  describe('batchItemFailureCount', () => {
    it('returns the number of failures', () => {
      assert.equal(batchItemFailureCount({ batchItemFailures: [{ id: '1' }, { id: '2' }] }), 2)
    })

    it('returns 0 for empty array', () => {
      assert.equal(batchItemFailureCount({ batchItemFailures: [] }), 0)
    })

    it('returns 0 for null response', () => {
      assert.equal(batchItemFailureCount(null), 0)
    })

    it('returns 0 for undefined response', () => {
      assert.equal(batchItemFailureCount(undefined), 0)
    })
  })
})
