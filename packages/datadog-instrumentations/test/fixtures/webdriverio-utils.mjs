const testFrameworkFnWrapper = async function (type, spec) {
  return spec(type)
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
