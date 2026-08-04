'use strict'

const request = require('../../exporters/common/request')
const log = require('../../log')
const Plugin = require('../../plugins/plugin')

const MAX_BATCH_BYTES = 5 * 1024 * 1024
const MAX_BATCH_LOGS = 1000
const BATCH_FLUSH_INTERVAL = 1000

/**
 * @typedef {object} LogSubmissionPayload
 * @property {string} source
 * @property {string | Record<string, unknown>} message
 */

/**
 * @typedef {object} LogBatch
 * @property {string[]} messages
 * @property {number} byteLength
 */

/**
 * @param {import('../../config/config-base')} config
 * @returns {URL}
 */
function getLogSubmissionUrl (config) {
  const defaultUrl = new URL(`https://http-intake.logs.${config.site}`)

  if (!config.DD_AGENTLESS_LOG_SUBMISSION_URL) {
    return defaultUrl
  }

  try {
    return new URL(config.DD_AGENTLESS_LOG_SUBMISSION_URL)
  } catch {
    log.error('Could not parse DD_AGENTLESS_LOG_SUBMISSION_URL')
    return defaultUrl
  }
}

/**
 * @param {string} source
 * @param {string} service
 * @returns {string}
 */
function getLogSubmissionPath (source, service) {
  return `/api/v2/logs?ddsource=${source}&service=${encodeURIComponent(service)}`
}

/**
 * @param {import('../../config/config-base')} config
 * @param {URL} url
 * @returns {object}
 */
function getWinstonLogSubmissionParameters (config, url) {
  const parameters = {
    host: url.hostname,
    path: getLogSubmissionPath('winston', config.service),
    ssl: url.protocol === 'https:',
    headers: {
      'DD-API-KEY': config.DD_API_KEY,
    },
  }

  if (url.port) {
    parameters.port = url.port
  }

  return parameters
}

/**
 * @param {string | Record<string, unknown>} message
 * @returns {string | undefined}
 */
function serializeLogMessage (message) {
  if (typeof message === 'string') return message

  const ancestors = []
  return JSON.stringify(message, function (key, value) {
    if (value === null || typeof value !== 'object') return value

    while (ancestors.length > 0 && ancestors.at(-1) !== this) {
      ancestors.pop()
    }

    if (ancestors.includes(value)) return '[Circular]'

    ancestors.push(value)
    return value
  })
}

class LogSubmissionPlugin extends Plugin {
  static id = 'log-submission'

  /** @type {Map<string, LogBatch>} */
  #batches = new Map()
  #beforeExitHandler = () => this.#flush()
  #logSubmissionUrl
  #timer

  constructor (...args) {
    super(...args)

    this.addSub('ci:log-submission:winston:configure', (httpClass) => {
      this.HttpClass = httpClass
    })

    this.addSub('ci:log-submission:winston:add-transport', (logger) => {
      logger.add(new this.HttpClass(getWinstonLogSubmissionParameters(this.config, this.#logSubmissionUrl)))
    })

    this.addSub('ci:log-submission:log', (payload) => this.#enqueueLog(payload))
    this.addSub('ci:playwright:test:finish', () => this.#flush())
  }

  /**
   * @param {boolean | (Record<string, unknown> & { enabled: boolean })} config
   * @returns {void}
   */
  configure (config) {
    if (this._enabled) {
      this.#flush()
    }

    super.configure(config)

    const beforeExitHandlers = globalThis[Symbol.for('dd-trace')].beforeExitHandlers
    if (this._enabled) {
      this.#logSubmissionUrl = getLogSubmissionUrl(this.config)
      beforeExitHandlers.add(this.#beforeExitHandler)
    } else {
      this.#logSubmissionUrl = undefined
      beforeExitHandlers.delete(this.#beforeExitHandler)
    }
  }

  /**
   * @param {LogSubmissionPayload} payload
   * @returns {void}
   */
  #enqueueLog ({ source, message }) {
    let serializedMessage
    try {
      serializedMessage = serializeLogMessage(message)
    } catch (error) {
      log.error('Could not serialize %s log for automatic submission', source, error)
      return
    }

    if (serializedMessage === undefined) return

    const messageBytes = Buffer.byteLength(serializedMessage)
    if (messageBytes + 2 > MAX_BATCH_BYTES) {
      log.error('Could not submit %s log because it exceeds the %d byte payload limit', source, MAX_BATCH_BYTES)
      return
    }

    let batch = this.#batches.get(source)
    if (batch !== undefined && batch.byteLength + messageBytes + 1 > MAX_BATCH_BYTES) {
      this.#flush()
      batch = undefined
    }

    if (batch === undefined) {
      batch = { messages: [], byteLength: 2 }
      this.#batches.set(source, batch)
    }

    if (batch.messages.length > 0) {
      batch.byteLength++
    }
    batch.messages.push(serializedMessage)
    batch.byteLength += messageBytes

    if (batch.messages.length === MAX_BATCH_LOGS || batch.byteLength === MAX_BATCH_BYTES) {
      this.#flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => this.#flush(), BATCH_FLUSH_INTERVAL)
      this.#timer.unref?.()
    }
  }

  /**
   * Flushes every source-specific batch.
   *
   * @returns {void}
   */
  #flush () {
    clearTimeout(this.#timer)
    this.#timer = undefined

    const batches = this.#batches
    this.#batches = new Map()

    for (const [source, batch] of batches) {
      const options = {
        path: getLogSubmissionPath(source, this.config.service),
        method: 'POST',
        headers: {
          'DD-API-KEY': this.config.DD_API_KEY,
          'Content-Type': 'application/json',
        },
        url: this.#logSubmissionUrl,
      }

      request(`[${batch.messages.join(',')}]`, options, (error) => {
        if (error) {
          log.error('Error submitting %s logs', source, error)
        }
      })
    }
  }
}

module.exports = LogSubmissionPlugin
