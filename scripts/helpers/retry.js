'use strict'

/**
 * Block the current thread for the given duration. Spacing out retries of a synchronous operation needs a synchronous
 * sleep; `Atomics.wait` on a throwaway buffer provides one without spawning a process.
 *
 * @param {number} ms
 */
function sleepSync (ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * @typedef {object} RetryOptions
 * @property {number} [attempts] Maximum number of attempts including the first (default 4).
 * @property {number} [baseDelayMs] Delay before the first retry, doubled on each subsequent retry (default 5000).
 * @property {(error: Error, attempt: number, delayMs: number) => void} [onRetry] Called before each backoff wait.
 * @property {(ms: number) => void} [sleep] Synchronous sleep, injectable for testing (default blocks the thread).
 */

/**
 * Run a synchronous function, retrying on any thrown error with exponential backoff.
 *
 * Install steps that download large prebuilt binaries (e.g. Electron fetches one archive per major from GitHub's
 * release CDN) intermittently fail with 5xx gateway errors. Retrying immediately lands in the same outage window, so
 * back off between attempts before giving up.
 *
 * @template T
 * @param {() => T} fn The operation to attempt.
 * @param {RetryOptions} [options]
 * @returns {T} The result of the first successful attempt.
 */
function retry (fn, { attempts = 4, baseDelayMs = 5000, onRetry, sleep = sleepSync } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn()
    } catch (error) {
      if (attempt >= attempts) throw error
      const delayMs = baseDelayMs * 2 ** (attempt - 1)
      onRetry?.(error, attempt, delayMs)
      sleep(delayMs)
    }
  }
}

module.exports = retry
