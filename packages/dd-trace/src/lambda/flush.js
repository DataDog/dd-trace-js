'use strict'

const NoopDogStatsDClient = require('../noop/dogstatsd')
const log = require('../log')

/**
 * Drains an initialized public client. Its Lambda delivery tracker bounds the wait, including earlier sends.
 * Reading the descriptor avoids creating sockets and an interval for functions that never use metrics.
 *
 * @returns {Promise<void>|undefined} Completion of the configured public metric transport.
 */
function flushDogStatsD () {
  const tracer = global._ddtrace
  const client = tracer && Object.getOwnPropertyDescriptor(tracer, 'dogstatsd')?.value
  if (!client || client instanceof NoopDogStatsDClient) return

  return new Promise(resolve => {
    try {
      client.flush(resolve)
    } catch (error) {
      log.error('Error flushing Lambda DogStatsD metrics: %s', error)
      resolve()
    }
  })
}

module.exports = { flushDogStatsD }
