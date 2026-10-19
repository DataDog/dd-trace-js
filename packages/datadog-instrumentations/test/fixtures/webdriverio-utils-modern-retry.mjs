const testFrameworkFnWrapper = async function (_wrapFunctions, type, { specFn }, _before, _after, _cid, _retries,
  hookName) {
  let error
  if (_before?.beforeFn) await _before.beforeFn()
  try {
    return specFn(type, hookName)
  } catch (caughtError) {
    error = caughtError
  }
  throw error
}

async function executeAsync (fn, retries, args = [], timeout = 2e4) {
  this.wdioRetries = retries.attempts
  try {
    const result = await fn.apply(this, args)
    return await result
  } catch (err) {
    const mochaTimedOut = err.message === 'Timeout'
    if (retries.limit > retries.attempts && !mochaTimedOut) {
      retries.attempts++
      return await executeAsync.call(this, fn, retries, args, timeout)
    }
    throw err
  }
}

export { executeAsync, testFrameworkFnWrapper }
