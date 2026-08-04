'use strict'

/**
 * Wait for the child process to emit a `{ name: 'traces', payload }` IPC message
 * that satisfies `fn`. Resolves on first success, rejects on timeout.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {(msg: { payload: object[][] }) => void} fn
 * @param {number} [timeout]
 * @returns {Promise<void>}
 */
function assertTraceReceived (child, fn, timeout = 2000) {
  let resolve, reject
  const errors = []
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  const timeoutObj = setTimeout(() => {
    const errorsMsg = errors.length === 0 ? '' : `, additionally:\n${errors.map(e => e.stack).join('\n')}\n===\n`
    reject(new Error(`timeout${errorsMsg}`))
    child.removeListener('message', handler)
  }, timeout)

  function handler (msg) {
    if (!msg || msg.name !== 'traces') return
    try {
      fn({ payload: msg.payload })
      clearTimeout(timeoutObj)
      resolve()
      child.removeListener('message', handler)
    } catch (e) {
      errors.push(e)
    }
  }

  child.on('message', handler)
  return promise
}

module.exports = { assertTraceReceived }
