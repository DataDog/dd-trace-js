async function executeAsync (fn, retries, args = [], timeout = 2e4) {
  this.wdioRetries = retries.attempts
  let timer
  let mochaTimedOut = false
  try {
    const result = await Promise.race([
      fn.apply(this, args),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          mochaTimedOut = typeof this?._runnable?._timeoutError === 'function'
          reject(mochaTimedOut ? this._runnable._timeoutError(timeout) : new Error(`Timeout after ${timeout}ms`))
        }, timeout)
      }),
    ])
    clearTimeout(timer)
    return await result
  } catch (err) {
    clearTimeout(timer)
    if (retries.limit > retries.attempts && !mochaTimedOut) {
      retries.attempts++
      return await executeAsync.call(this, fn, retries, args, timeout)
    }
    throw err
  }
}

export { executeAsync }
