'use strict'

const TEST_FUNC_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:target'

let _mod, _testing

async function setup (mod, versionMod) {
  _mod = mod
  _testing = versionMod.get('@aws/durable-execution-sdk-js-testing')
  await _testing.LocalDurableTestRunner.setupTestEnvironment({ skipTime: true })
}

async function teardown () {
  await _testing?.LocalDurableTestRunner.teardownTestEnvironment()
  _mod = undefined
  _testing = undefined
}

/**
 * Drive a durable handler through `LocalDurableTestRunner`. The runner simulates the
 * checkpoint server in-process and (with `skipTime: true`) advances virtual time so any
 * `ctx.wait(...)` naturally suspends and resumes the handler — second invocation enters
 * ReplayMode automatically, mirroring the pattern used by `dd-trace-py`.
 *
 * @param {(event: object, ctx: object) => Promise<unknown>} handlerFn
 * @param {object} [opts]
 * @param {(event: object, ctx: object) => Promise<unknown>} [opts.invokeTarget] - Plain
 *   handler registered as the target of `ctx.invoke(...)`. If it throws, the SDK wraps the
 *   failure into `ChainedInvokeDetails.Error` (rejected with `InvokeError`).
 * @param {string} [opts.resolveCallback] - Name of a `ctx.waitForCallback(name, ...)` op
 *   to resolve mid-execution. Without this, `waitForCallback` would never complete and
 *   `runner.run()` would hang.
 * @returns {Promise<object>} The runner's TestResult.
 */
async function invokeHandler (handlerFn, opts = {}) {
  const runner = new _testing.LocalDurableTestRunner({
    handlerFunction: _mod.withDurableExecution(handlerFn),
  })
  if (opts.invokeTarget) {
    runner.registerFunction(TEST_FUNC_ARN, opts.invokeTarget)
  }

  const runPromise = runner.run({ payload: { testInput: true } })

  if (opts.resolveCallback) {
    runner.getOperation(opts.resolveCallback)
      .waitForData(_testing.WaitingOperationStatus.SUBMITTED)
      .then(op => op.sendCallbackSuccess(JSON.stringify('ok')))
      .catch(() => { /* runner.run() may complete first; ignore */ })
  }

  return runPromise
}

module.exports = {
  TEST_FUNC_ARN,
  invokeHandler,
  setup,
  teardown,
}
