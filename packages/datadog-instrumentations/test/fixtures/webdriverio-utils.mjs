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

async function executeAsync (fn, retries, args = [], timeout) {
  try {
    const result = await fn(...args)
    return await result
  } catch (err) {
    if (retries.limit > retries.attempts) {
      retries.attempts++
      return await executeAsync.call(this, fn, retries, args, timeout)
    }
    throw err
  }
}

export { executeAsync, testFrameworkFnWrapper }
