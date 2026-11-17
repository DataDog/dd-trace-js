'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { describe, it } = require('mocha')

const { HANDLER_STREAMING, STREAM_RESPONSE, promisifiedHandler } = require('../src/helpers/lambda-handler')

describe('Lambda shim completion policy', () => {
  it('supports callbacks, promises and synchronous values', async () => {
    for (const handler of [
      (_event, _context, callback) => callback(null, 'done'),
      () => Promise.resolve('done'),
      () => 'done',
    ]) {
      const wrapped = promisifiedHandler(handler)
      assert.strictEqual(await wrapped({}, {}), 'done')
    }
  })

  it('uses the supplied context and replaces its completion methods', async () => {
    const context = {}
    const original = () => { assert.fail('native completion must be owned by the outer runtime') }
    context.succeed = original
    const handler = promisifiedHandler((event, ctx) => {
      assert.strictEqual(ctx, context)
      ctx.succeed(event)
    })
    assert.strictEqual(await handler('done', context), 'done')
    assert.notStrictEqual(context.succeed, original)
    assert.strictEqual(context.callbackWaitsForEmptyEventLoop, false)
  })

  for (const method of ['done', 'succeed', 'fail']) {
    it('waits for asynchronous context.' + method, async () => {
      const context = {}
      const wrapped = promisifiedHandler(() => {})
      const result = wrapped({}, context)
      let settled = false
      const observed = result.then(
        value => { settled = true; return value },
        error => { settled = true; throw error }
      )
      await Promise.resolve()
      assert.strictEqual(settled, false)
      const error = new Error('failure')
      if (method === 'done') context.done(null, 'done')
      else if (method === 'succeed') context.succeed('done')
      else context.fail(error)
      if (method === 'fail') await assert.rejects(observed, e => e === error)
      else assert.strictEqual(await observed, 'done')
      assert.strictEqual(context.callbackWaitsForEmptyEventLoop, false)
    })
  }

  it('waits for a declared callback despite an incidental return value', async () => {
    let complete
    const wrapped = promisifiedHandler((_event, _context, callback) => {
      complete = callback
      return 'incidental'
    })
    const result = wrapped({}, {})
    let settled = false
    const observed = result.then(value => { settled = true; return value })
    await Promise.resolve()
    assert.strictEqual(settled, false)
    complete(null, 'callback')
    assert.strictEqual(await observed, 'callback')
  })

  for (const artifact of [
    { listen () {}, close () {} },
    { on () {}, emit () {} },
    new EventEmitter(),
  ]) {
    it('waits for context completion after returning a side-effect artifact', async () => {
      const context = {}
      const wrapped = promisifiedHandler(() => artifact)
      const result = wrapped({}, context)
      let settled = false
      const observed = result.then(value => { settled = true; return value })
      await Promise.resolve()
      assert.strictEqual(settled, false)
      context.succeed('done')
      assert.strictEqual(await observed, 'done')
    })
  }

  it('returns ordinary objects directly', async () => {
    const value = { statusCode: 200 }
    const wrapped = promisifiedHandler(() => value)
    assert.strictEqual(await wrapped({}, {}), value)
  })

  it('races callbacks against returned promises', async () => {
    let callback
    const callbackFirst = promisifiedHandler((_event, _context, done) => {
      done(null, 'callback')
      return Promise.resolve('promise')
    })
    const promiseFirst = promisifiedHandler((_event, _context, done) => {
      callback = done
      return Promise.resolve('promise')
    })
    assert.strictEqual(await callbackFirst({}, {}), 'callback')
    assert.strictEqual(await promiseFirst({}, {}), 'promise')
    callback(null, 'late')
  })

  it('preserves errors from callbacks, returned promises and synchronous throws', async () => {
    const error = new Error('failure')
    const callbackHandler = promisifiedHandler((_event, _context, done) => done(error))
    const rejected = promisifiedHandler(() => Promise.reject(error))
    const thrown = promisifiedHandler(() => { throw error })
    await assert.rejects(callbackHandler({}, {}), e => e === error)
    await assert.rejects(rejected({}, {}), e => e === error)
    assert.throws(() => thrown({}, {}), e => e === error)
  })

  it('passes streaming arguments through and returns the same promise', async () => {
    const event = {}
    const stream = {}
    const context = {}
    const promise = Promise.resolve('streamed')
    const handler = (input, responseStream, ctx) => {
      assert.strictEqual(input, event)
      assert.strictEqual(responseStream, stream)
      assert.strictEqual(ctx, context)
      return promise
    }
    handler[HANDLER_STREAMING] = STREAM_RESPONSE
    const wrapped = promisifiedHandler(handler)
    assert.strictEqual(wrapped(event, stream, context), promise)
    assert.strictEqual(await promise, 'streamed')
  })
})
