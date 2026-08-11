'use strict'

const { Writable } = require('node:stream')

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
 * @typedef {object} PendingLogRequest
 * @property {string} source
 */

/**
 * @typedef {object} LogRequestCompletion
 * @property {() => void} complete
 * @property {Set<PendingLogRequest>} pendingRequests
 */

/**
 * @param {import('../../config/config-base')} config
 * @returns {URL | undefined}
 */
function getLogSubmissionUrl (config) {
  if (config.DD_AGENTLESS_LOG_SUBMISSION_URL) {
    try {
      const url = new URL(config.DD_AGENTLESS_LOG_SUBMISSION_URL)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url

      log.error('Unsupported automatic log submission URL protocol: %s', url.protocol)
    } catch {
      log.error('Could not parse DD_AGENTLESS_LOG_SUBMISSION_URL')
    }
  }

  const hostname = `http-intake.logs.${config.site}`
  try {
    const url = new URL(`https://${hostname}`)
    if (url.hostname === hostname.toLowerCase()) return url
  } catch {}
  log.error('Could not parse automatic log submission site: %s', config.site)
}

/**
 * @param {string} source
 * @param {string} service
 * @returns {string}
 */
function getLogSubmissionPath (source, service) {
  return `/api/v2/logs?${new URLSearchParams({ ddsource: source, service })}`
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
  /** @type {Set<PendingLogRequest>} */
  #pendingRequests = new Set()
  /** @type {LogRequestCompletion[]} */
  #requestCompletions = []
  #timer
  #winstonStreamClass

  constructor (...args) {
    super(...args)

    this.addSub('ci:log-submission:winston:configure', (streamClass) => {
      this.#winstonStreamClass = streamClass
    })

    this.addSub('ci:log-submission:winston:add-transport', (logger) => {
      this.#addWinstonTransport(logger)
    })

    this.addSub('ci:log-submission:log', (payload) => this.#enqueueLog(payload))
    this.addSub('ci:agentless:flush', ({ registerCompletion } = {}) => {
      this.#flush(registerCompletion)
    })
  }

  /**
   * @param {{ add: (transport: object) => void }} logger
   * @returns {void}
   */
  #addWinstonTransport (logger) {
    const stream = new Writable({
      objectMode: true,
      /**
       * @param {Record<string, unknown>} message
       * @param {string} encoding
       * @param {(error?: Error | null) => void} callback
       */
      write: (message, encoding, callback) => {
        this.#enqueueLog({ source: 'winston', message })
        callback()
      },
    })
    logger.add(new this.#winstonStreamClass({ stream }))
  }

  /**
   * @param {boolean | (Record<string, unknown> & { enabled: boolean })} config
   * @returns {void}
   */
  configure (config) {
    if (this._enabled) {
      this.#flush()
    }

    const isEnabled = typeof config === 'boolean' ? config : config.enabled
    const logSubmissionUrl = isEnabled && typeof config !== 'boolean' ? getLogSubmissionUrl(config) : undefined
    this.#logSubmissionUrl = logSubmissionUrl
    super.configure(isEnabled && !logSubmissionUrl ? false : config)

    const beforeExitHandlers = globalThis[Symbol.for('dd-trace')].beforeExitHandlers
    if (this._enabled) {
      beforeExitHandlers.add(this.#beforeExitHandler)
    } else {
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
   * @param {(() => (() => void)) | undefined} registerCompletion
   * @returns {void}
   */
  #flush (registerCompletion) {
    clearTimeout(this.#timer)
    this.#timer = undefined

    const batches = this.#batches
    this.#batches = new Map()
    const requests = []

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
      const pendingRequest = { source }
      this.#pendingRequests.add(pendingRequest)
      requests.push({
        data: `[${batch.messages.join(',')}]`,
        options,
        pendingRequest,
      })
    }

    if (registerCompletion && this.#pendingRequests.size > 0) {
      this.#requestCompletions.push({
        complete: registerCompletion(),
        pendingRequests: new Set(this.#pendingRequests),
      })
    }

    for (const { data, options, pendingRequest } of requests) {
      try {
        request(data, options, error => this.#finishRequest(pendingRequest, error))
      } catch (error) {
        this.#finishRequest(pendingRequest, error)
      }
    }
  }

  /**
   * Records a completed request and releases lifecycle barriers waiting for that request.
   *
   * @param {PendingLogRequest} pendingRequest
   * @param {Error | null | undefined} error
   * @returns {void}
   */
  #finishRequest (pendingRequest, error) {
    this.#pendingRequests.delete(pendingRequest)

    if (error) {
      log.error('Error submitting %s logs', pendingRequest.source, error)
    }

    const requestCompletions = this.#requestCompletions
    this.#requestCompletions = []
    for (const requestCompletion of requestCompletions) {
      requestCompletion.pendingRequests.delete(pendingRequest)
      if (requestCompletion.pendingRequests.size === 0) {
        requestCompletion.complete()
      } else {
        this.#requestCompletions.push(requestCompletion)
      }
    }
  }
}

module.exports = LogSubmissionPlugin
