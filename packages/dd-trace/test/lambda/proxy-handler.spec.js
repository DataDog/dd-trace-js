'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, realpathSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')

const lambdaPath = require.resolve('../../src/lambda')

const fixture = `
  const calls = []
  const original = function (event, context, callback) {
    if (event.error) throw event.error
    return { receiver: this, event, context, callback }
  }
  const handler = new Proxy(original, {
    get () { calls.push('get'); throw new Error('Unexpected Proxy get') },
    ownKeys () { calls.push('ownKeys'); throw new Error('Unexpected Proxy ownKeys') },
    getOwnPropertyDescriptor () { calls.push('descriptor'); throw new Error('Unexpected Proxy descriptor') },
    getPrototypeOf () { calls.push('prototype'); throw new Error('Unexpected Proxy prototype') },
    apply (target, receiver, args) { return Reflect.apply(target, receiver, args) }
  })
  exports.calls = calls
  Object.defineProperty(exports, 'handler', {
    value: handler, configurable: true, enumerable: true, writable: process.env.READONLY !== 'true'
  })
`

describe('Lambda Proxy handler registration', () => {
  let taskRoot

  beforeEach(() => {
    taskRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'dd-trace-lambda-proxy-')))
    writeFileSync(path.join(taskRoot, 'handler.js'), fixture)
  })

  afterEach(() => {
    rmSync(taskRoot, { recursive: true, force: true })
  })

  for (const readonly of [false, true]) {
    it(`wraps a Proxy exported through a ${readonly ? 'readonly configurable' : 'writable'} property`, () => {
      const script = `
        const assert = require('node:assert/strict')
        const { isProxy } = require('node:util').types
        require(${JSON.stringify(lambdaPath)})
        const app = require(${JSON.stringify(path.join(taskRoot, 'handler.js'))})
        assert.strictEqual(isProxy(app.handler), false)
        const descriptor = Object.getOwnPropertyDescriptor(app, 'handler')
        assert.strictEqual(descriptor.writable, ${!readonly})
        assert.strictEqual(descriptor.enumerable, true)
        assert.strictEqual(descriptor.configurable, true)
        const receiver = {}
        const event = {}
        const context = { getRemainingTimeInMillis: () => 100 }
        global._ddtrace = { _tracer: { _config: { DD_APM_FLUSH_DEADLINE_MILLISECONDS: 25 } } }
        const result = app.handler.call(receiver, event, context)
        assert.strictEqual(result.receiver, receiver)
        assert.strictEqual(result.event, event)
        assert.strictEqual(result.context, context)
        assert.strictEqual(app.handler[Symbol.for('aws.lambda.runtime.handler.streaming')], undefined)
        assert.strictEqual(app.handler[Symbol.for('aws.lambda.runtime.handler.streaming.highWaterMark')], undefined)
        assert.strictEqual(app.handler.length, 0)
        assert.deepStrictEqual(app.calls, [])
      `
      const result = spawnSync(process.execPath, ['--eval', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          AWS_LAMBDA_FUNCTION_NAME: 'proxy-handler',
          LAMBDA_TASK_ROOT: taskRoot,
          DD_LAMBDA_HANDLER: 'handler.handler',
          DD_TRACE_DISABLED_INSTRUMENTATIONS: '',
          READONLY: String(readonly),
        },
      })
      assert.strictEqual(result.status, 0, result.stderr)
    })
  }

  for (const marker of [true, false]) {
    it(`preserves a safe _ddWrapped marker with value ${marker}`, () => {
      writeFileSync(path.join(taskRoot, 'handler.js'), `
        exports.handler = function (event, context) { return 'already wrapped' }
        exports.handler._ddWrapped = ${marker}
      `)
      const script = `
        const assert = require('node:assert/strict')
        require(${JSON.stringify(lambdaPath)})
        const app = require(${JSON.stringify(path.join(taskRoot, 'handler.js'))})
        assert.strictEqual(app.handler._ddWrapped, ${marker})
      `
      const result = spawnSync(process.execPath, ['--eval', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          AWS_LAMBDA_FUNCTION_NAME: 'proxy-handler',
          LAMBDA_TASK_ROOT: taskRoot,
          DD_LAMBDA_HANDLER: 'handler.handler',
          DD_TRACE_DISABLED_INSTRUMENTATIONS: '',
        },
      })
      assert.strictEqual(result.status, 0, result.stderr)
    })
  }

  it('preserves application failures and invokes a Proxy when monitoring is unavailable', () => {
    const script = `
      const assert = require('node:assert/strict')
      require(${JSON.stringify(lambdaPath)})
      const app = require(${JSON.stringify(path.join(taskRoot, 'handler.js'))})
      const error = new Error('application failure')
      assert.throws(() => app.handler({ error }), candidate => candidate === error)
      const event = {}
      assert.strictEqual(app.handler(event).event, event)
      const context = { getRemainingTimeInMillis: () => NaN }
      assert.strictEqual(app.handler(event, context).context, context)
      assert.deepStrictEqual(app.calls, [])
    `
    const result = spawnSync(process.execPath, ['--eval', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AWS_LAMBDA_FUNCTION_NAME: 'proxy-handler',
        LAMBDA_TASK_ROOT: taskRoot,
        DD_LAMBDA_HANDLER: 'handler.handler',
        DD_TRACE_DISABLED_INSTRUMENTATIONS: '',
      },
    })
    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('does not inspect or replace a handler when Lambda instrumentation is disabled', () => {
    const script = `
      const assert = require('node:assert/strict')
      const { isProxy } = require('node:util').types
      require(${JSON.stringify(lambdaPath)})
      const app = require(${JSON.stringify(path.join(taskRoot, 'handler.js'))})
      assert.strictEqual(isProxy(app.handler), true)
      assert.deepStrictEqual(app.calls, [])
    `
    const result = spawnSync(process.execPath, ['--eval', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AWS_LAMBDA_FUNCTION_NAME: 'proxy-handler',
        LAMBDA_TASK_ROOT: taskRoot,
        DD_LAMBDA_HANDLER: 'handler.handler',
        DD_TRACE_DISABLED_INSTRUMENTATIONS: 'lambda',
      },
    })
    assert.strictEqual(result.status, 0, result.stderr)
  })
})
