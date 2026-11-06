'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { describe, it } = require('mocha')

const { promisifiedHandler } = require('../src/helpers/lambda-handler')

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

  describe('first completion', () => {
    for (const mode of ['auto', 'callback']) {
      for (const method of ['callback', 'done', 'succeed', 'fail']) {
        for (const after of ['throw', 'return']) {
          it(`keeps ${method} completion before a subsequent ${after} in ${mode} mode`, async () => {
            const context = { getRemainingTimeInMillis: () => 100 }
            const firstError = new Error('first completion')
            const wrapped = promisifiedHandler((...args) => {
              const complete = method === 'callback' ? args[2] : context[method].bind(context)
              if (method === 'fail') complete(firstError)
              else if (method === 'succeed') complete('first result')
              else complete(null, 'first result')
              if (after === 'throw') throw new Error('after completion')
              return 'incidental result'
            }, mode)
            const result = wrapped({}, context, () => {})
            if (method === 'fail') await assert.rejects(result, error => error === firstError)
            else assert.strictEqual(await result, 'first result')
          })
        }
      }
    }

    for (const value of [undefined, null, false, 0, '']) {
      it(`preserves a thrown ${String(value)} as a rejection`, async () => {
        const wrapped = promisifiedHandler(() => { throw value })
        await assert.rejects(wrapped({}, {}), error => error === value)
      })
    }
  })

  describe('callback completion', () => {
    for (const shape of ['rest', 'default']) {
      for (const supplied of [false, true]) {
        it(`waits for a ${shape} callback with a runtime callback ${supplied}`, async () => {
          const receiver = {}
          const context = { getRemainingTimeInMillis: () => 100 }
          const event = {}
          const extra = {}
          let complete
          const capture = function (input, ctx, callback, additional) {
            assert.strictEqual(this, receiver)
            assert.strictEqual(input, event)
            assert.strictEqual(ctx, context)
            assert.strictEqual(additional, extra)
            complete = callback
            return { incidental: true }
          }
          const handler = shape === 'rest'
            ? function (...args) { return capture.apply(this, args) }
            : function (input, ctx, callback = () => {}, additional) {
              return capture.call(this, input, ctx, callback, additional)
            }
          let settled = false
          const wrapped = promisifiedHandler(handler, 'callback')
          const observed = wrapped.call(receiver, event, context, supplied ? () => {} : undefined, extra)
            .then(value => { settled = true; return value })
          await Promise.resolve()
          assert.strictEqual(settled, false, 'incidental returns must not complete the invocation')
          assert.strictEqual(typeof complete, 'function')
          complete(null, 'callback result')
          complete(new Error('ignored duplicate'))
          assert.strictEqual(await observed, 'callback result')
        })
      }
    }

    for (const value of [undefined, null, false, 0, '', { ok: true }]) {
      it(`ignores a synchronous ${String(value)} return until callback failure`, async () => {
        let complete
        const wrapped = promisifiedHandler((...args) => { complete = args[2]; return value }, 'callback')
        let settled = false
        const error = new Error('callback failure')
        const observed = wrapped({}, {}).then(() => { assert.fail('expected callback rejection') }, failure => {
          settled = true
          assert.strictEqual(failure, error)
        })
        await Promise.resolve()
        assert.strictEqual(settled, false)
        assert.strictEqual(typeof complete, 'function')
        complete(error)
        await observed
      })
    }

    for (const method of ['done', 'succeed', 'fail']) {
      it(`waits for context.${method} and preserves a third-argument context`, async () => {
        const context = { getRemainingTimeInMillis: () => 100 }
        const wrapped = promisifiedHandler((_event, placeholder, ctx) => {
          assert.deepStrictEqual(placeholder, {})
          assert.strictEqual(ctx, context)
          return 'incidental'
        }, 'callback')
        const error = new Error('context failure')
        let settled = false
        const result = wrapped({}, {}, context)
        const observed = result.then(value => {
          settled = true
          assert.strictEqual(value, 'context result')
        }, failure => {
          settled = true
          assert.strictEqual(failure, error)
        })
        await Promise.resolve()
        assert.strictEqual(settled, false)
        if (method === 'done') context.done(null, 'context result')
        if (method === 'succeed') context.succeed('context result')
        if (method === 'fail') context.fail(error)
        await observed
        assert.strictEqual(context.callbackWaitsForEmptyEventLoop, false)
      })
    }

    for (const first of ['callback', 'promise']) {
      for (const failure of [false, true]) {
        it(`preserves the Promise race when ${first} completes first with failure ${failure}`, async () => {
          let complete
          let resolvePromise
          let rejectPromise
          const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })
          const wrapped = promisifiedHandler((...args) => { complete = args[2]; return promise }, 'callback')
          const error = new Error('first failure')
          const result = wrapped({}, {}, () => {})
          const observed = failure
            ? assert.rejects(result, value => value === error)
            : result.then(value => { assert.strictEqual(value, first) })
          if (first === 'callback') complete(failure ? error : null, first)
          else if (failure) rejectPromise(error)
          else resolvePromise(first)
          await observed
          // The losing rejection must remain handled, and completion must not change.
          if (first === 'callback') rejectPromise(new Error('losing rejection'))
          else complete(new Error('losing callback'))
        })
      }
    }

    it('rejects a synchronous throw and accepts a returned thenable', async () => {
      const error = new Error('synchronous failure')
      const throwing = promisifiedHandler(() => { throw error }, 'callback')
      const thenable = promisifiedHandler(() => ({ then: resolve => resolve('thenable') }), 'callback')
      await Promise.all([
        assert.rejects(throwing({}, {}), value => value === error),
        thenable({}, {}).then(value => { assert.strictEqual(value, 'thenable') }),
      ])
    })
  })

  describe('return completion', () => {
    for (const value of [undefined, null, false, 0, '', { ok: true }, new EventEmitter()]) {
      it(`accepts a synchronous ${String(value)} result even with three declared parameters`, async () => {
        const handler = promisifiedHandler((_event, _context, _unused) => value, 'return')
        let settled = false
        const observed = handler({}, { getRemainingTimeInMillis: () => 100 }).then(result => {
          settled = true
          assert.strictEqual(result, value)
        })
        await Promise.resolve()
        assert.strictEqual(settled, true)
        await observed
      })
    }

    it('preserves the receiver, extra arguments, and context accessors', async () => {
      const receiver = {}
      const context = { getRemainingTimeInMillis: () => 100 }
      for (const name of ['done', 'succeed', 'fail']) {
        Object.defineProperty(context, name, {
          get () { throw new Error('context methods must not be read') },
        })
      }
      const args = [{ event: true }, context, () => {}, { extra: true }]
      const wrapped = promisifiedHandler(function (...actual) {
        assert.strictEqual(this, receiver)
        assert.deepStrictEqual(actual, args)
        return { then: resolve => resolve('thenable result') }
      }, 'return')
      assert.strictEqual(await wrapped.apply(receiver, args), 'thenable result')
    })

    for (const failure of ['throw', 'reject']) {
      it(`rejects a handler ${failure}`, async () => {
        const error = new Error('failure')
        const wrapped = promisifiedHandler(() => {
          if (failure === 'throw') throw error
          return Promise.reject(error)
        }, 'return')
        await assert.rejects(wrapped({}, { getRemainingTimeInMillis: () => 100 }), value => value === error)
      })
    }
  })
})
