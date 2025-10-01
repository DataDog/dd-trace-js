'use strict'

const retry = require('retry')
const BaseRetryOperation = require('retry/lib/retry_operation')

const options = {
  retries: 60,
  factor: 1,
  minTimeout: 1000,
  maxTimeout: 1000,
  randomize: false
}

class RetryOperation extends BaseRetryOperation {
  constructor (service) {
    const timeouts = retry.timeouts(options)

    super(timeouts, { service })
  }

  /** @this {{ _options: { service?: string } }} */
  retry (error) {
    const shouldRetry = super.retry(error)

    if (shouldRetry) {
      logAttempt(this._options.service, error.message)
    }

    return shouldRetry
  }
}

Object.assign(RetryOperation, options)

function logAttempt (service, message) {
  // eslint-disable-next-line no-console
  console.error(`[Retrying connection to ${service}] ${message}`)
}

/**
 * @typedef {new (service: string) => import('retry/lib/retry_operation')} RetryOperationConstructor
 */
/** @type {RetryOperationConstructor} */
module.exports = RetryOperation
