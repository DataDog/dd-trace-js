'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

const { describe, it } = require('mocha')

const helperPath = require.resolve('../../../datadog-instrumentations/src/helpers/lambda-handler')
const facadePath = require.resolve('../../../../lambda')

describe('Lambda discarded callback completion', () => {
  for (const entry of ['helper', 'facade']) {
    for (const selected of ['return', 'throw', 'promise', 'then getter']) {
      for (const method of ['rest callback', 'default callback', 'done', 'fail']) {
        it(`handles a late ${method} error after ${selected} completion through the ${entry}`, () => {
          // A child process with strict rejection handling proves that no discarded rejection escapes.
          // No process-level rejection listener can accidentally hide the failure from Mocha.
          const script = `
            const assert = require('node:assert/strict')
            const wrap = ${entry === 'helper'
              ? `require(${JSON.stringify(helperPath)}).promisifiedHandler`
              : `require(${JSON.stringify(facadePath)}).wrap`}
            const selected = ${JSON.stringify(selected)}
            const method = ${JSON.stringify(method)}
            const context = { getRemainingTimeInMillis: () => 100 }
            const firstError = new Error('selected error')
            let complete
            function run(event, ctx, callback) {
              complete = method.includes('callback') ? callback : ctx[method].bind(ctx)
              if (selected === 'throw') throw firstError
              if (selected === 'then getter') return { get then() { throw firstError } }
              return selected === 'promise' ? Promise.resolve('selected result') : 'selected result'
            }
            const handler = method === 'rest callback'
              ? (...args) => run(...args)
              : (event, ctx, callback = () => {}) => run(event, ctx, callback)
            async function check() {
              const options = ${entry === 'helper' ? "'auto'" : "{ handlerCompletion: 'auto' }"}
              const result = wrap(handler, options)({}, context, () => {})
              assert.ok(result instanceof Promise)
              if (selected === 'throw' || selected === 'then getter') {
                await assert.rejects(result, error => error === firstError)
              } else {
                assert.strictEqual(await result, 'selected result')
              }
              complete(new Error('discarded callback error'))
              // Advance one event-loop turn so Node performs its unhandled-rejection check.
              setImmediate(() => { process.stdout.write('completed') })
            }
            check().catch(error => { console.error(error); process.exitCode = 1 })
          `
          const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--eval', script], {
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env, DD_TRACE_ENABLED: 'false' },
          })
          assert.strictEqual(result.status, 0, result.stderr)
          assert.strictEqual(result.stdout, 'completed')
        })
      }
    }
  }
})
