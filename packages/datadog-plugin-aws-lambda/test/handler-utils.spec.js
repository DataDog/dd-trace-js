'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { describe, it } = require('mocha')

const { promisifiedHandler } = require('../src/handler-utils')

describe('Lambda handler utilities', () => {
  it('supports callback, promise, and synchronous handlers', async () => {
    const context = { getRemainingTimeInMillis: () => 100 }
    const callbackHandler = promisifiedHandler((_event, _context, done) => done(undefined, 'callback'))
    const promise = promisifiedHandler(() => Promise.resolve('promise'))
    const synchronous = promisifiedHandler(() => 'synchronous')

    assert.deepStrictEqual(
      await Promise.all([
        callbackHandler({}, context, () => {}),
        promise({}, context),
        synchronous({}, context),
      ]),
      ['callback', 'promise', 'synchronous']
    )
  })

  it('supports context done, succeed, and fail completion', async () => {
    const doneContext = { getRemainingTimeInMillis: () => 100 }
    const succeedContext = { getRemainingTimeInMillis: () => 100 }
    const failContext = { getRemainingTimeInMillis: () => 100 }

    const done = promisifiedHandler((_event, context) => {
      setImmediate(() => context.done(undefined, 'done'))
    })
    const succeed = promisifiedHandler((_event, context) => {
      setImmediate(() => context.succeed('succeed'))
    })
    const fail = promisifiedHandler((_event, context) => {
      setImmediate(() => context.fail(new Error('fail')))
    })

    const failed = assert.rejects(fail({}, failContext), { message: 'fail' })
    const results = await Promise.all([done({}, doneContext), succeed({}, succeedContext), failed])

    assert.deepStrictEqual(results, ['done', 'succeed', undefined])
    assert.strictEqual(doneContext.callbackWaitsForEmptyEventLoop, false)
    assert.strictEqual(succeedContext.callbackWaitsForEmptyEventLoop, false)
    assert.strictEqual(failContext.callbackWaitsForEmptyEventLoop, false)
  })

  it('waits for context completion when a handler returns a side-effect artifact', async () => {
    const context = { getRemainingTimeInMillis: () => 100 }
    const handler = promisifiedHandler((_event, invocationContext) => {
      setImmediate(() => invocationContext.succeed('finished'))
      return new EventEmitter()
    })

    assert.strictEqual(await handler({}, context), 'finished')
  })

  it('preserves a context supplied in the third argument', async () => {
    const context = { getRemainingTimeInMillis: () => 100 }
    const handler = promisifiedHandler((_event, placeholder, invocationContext) => {
      assert.deepStrictEqual(placeholder, {})
      assert.strictEqual(invocationContext, context)
      return 'result'
    })

    assert.strictEqual(await handler({}, {}, context), 'result')
  })
})
