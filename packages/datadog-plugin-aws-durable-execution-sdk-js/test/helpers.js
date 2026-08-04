'use strict'

const TEST_FUNC_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:target'

let _mod, _testing

async function setup (mod, versionMod) {
  _mod = mod
  _testing = versionMod.get('@aws/durable-execution-sdk-js-testing')
  await _testing.LocalDurableTestRunner.setupTestEnvironment()
}

async function teardown () {
  await _testing?.LocalDurableTestRunner.teardownTestEnvironment()
  _mod = undefined
  _testing = undefined
}

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
      .catch(() => {})
  }

  return runPromise
}

module.exports = {
  TEST_FUNC_ARN,
  invokeHandler,
  setup,
  teardown,
}
