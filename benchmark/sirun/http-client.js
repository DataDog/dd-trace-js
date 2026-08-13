'use strict'

const http = require('node:http')

const retryDelay = 10
const timeout = 30_000

/**
 * Run separate warmup and measured request phases on one keep-alive agent.
 *
 * @param {import('node:http').RequestOptions} options
 * @param {number} warmupCount
 * @param {number} measuredCount
 * @param {number} concurrency
 * @returns {void}
 */
module.exports = function runRequests (options, warmupCount, measuredCount, concurrency) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency })
  const requestOptions = { ...options, agent }
  let phaseRequestCount
  let requestsStarted = 0
  let requestsCompleted = 0
  let stopped = false
  let warmingUp = true
  let lastError

  const deadline = setTimeout(() => {
    stopped = true
    process.exitCode = 1
    agent.destroy()
    process.stderr.write(`HTTP benchmark client timed out${lastError ? `: ${lastError}` : ''}\n`)
  }, timeout)

  function startRequest () {
    if (stopped || requestsStarted >= phaseRequestCount) return

    requestsStarted++
    let settled = false

    /**
     * @param {Error} [error]
     */
    const retry = (error) => {
      if (settled || stopped) return

      settled = true
      requestsStarted--
      lastError = error?.message ?? lastError

      setTimeout(startRequest, retryDelay)
    }

    /**
     * @param {import('node:http').IncomingMessage} response
     */
    function onResponse (response) {
      response.resume()
      response.once('aborted', retry)
      response.once('error', retry)
      response.once('end', () => {
        if (settled || stopped) return

        settled = true
        requestsCompleted++
        deadline.refresh()
        if (requestsCompleted === phaseRequestCount) {
          if (warmingUp) {
            warmingUp = false
            startPhase(measuredCount)
          } else {
            stopped = true
            clearTimeout(deadline)
            agent.destroy()
          }
        } else {
          startRequest()
        }
      })
    }

    const request = http.get(requestOptions, onResponse)
    request.once('error', retry)
  }

  /**
   * @param {number} count
   */
  function startPhase (count) {
    phaseRequestCount = count
    requestsStarted = 0
    requestsCompleted = 0

    for (let i = 0; i < Math.min(concurrency, phaseRequestCount); i++) {
      startRequest()
    }
  }

  startPhase(warmupCount)
}
