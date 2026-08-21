'use strict'

const { Writable } = require('node:stream')

const request = require('../../exporters/common/request')
const log = require('../../log')
const Plugin = require('../../plugins/plugin')

const MAX_BATCH_BYTES = 5 * 1024 * 1024
const MAX_BATCH_LOGS = 1000
const BATCH_FLUSH_INTERVAL = 1000

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
    return
  }

  const hostname = `http-intake.logs.${config.site}`.toLowerCase()
  try {
    const url = new URL(`https://${hostname}`)
    if (url.hostname === hostname) return url
  } catch {}

  log.error('Could not parse automatic log submission site: %s', config.site)
}

/**
 * @param {import('../../config/config-base')} config
 * @param {string} source
 * @returns {string}
 */
function getLogSubmissionPath (config, source) {
  return `/api/v2/logs?${new URLSearchParams({ ddsource: source, service: config.service })}`
}

class LogSubmissionPlugin extends Plugin {
  static id = 'log-submission'

  /** @type {string[]} */
  #batch = []
  #batchBytes = 2
  #batchSource
  #logSubmissionUrl
  /** @type {Set<PendingLogRequest>} */
  #pendingRequests = new Set()
  /** @type {LogRequestCompletion[]} */
  #requestCompletions = []
  #timer
  #beforeExitHandler = () => this.#flushLogs()
  #createWinstonJsonFormat
  #winstonStreamClass
  #winstonOutput = new Writable({
    decodeStrings: false,
    write: (message, encoding, callback) => {
      this.#enqueueLog({ source: 'winston', message })
      callback()
    },
  })

  constructor (...args) {
    super(...args)

    const pendingWinstonLoggers = new Set()
    const addWinstonTransport = (logger) => {
      if (!this.#winstonStreamClass || !this.#createWinstonJsonFormat) {
        pendingWinstonLoggers.add(logger)
        return
      }

      logger.add(new this.#winstonStreamClass({
        format: this.#createWinstonJsonFormat(),
        stream: this.#winstonOutput,
      }))
    }

    this.addSub('ci:log-submission:winston:configure', ({ StreamTransport, createJsonFormat }) => {
      this.#winstonStreamClass = StreamTransport
      this.#createWinstonJsonFormat = createJsonFormat

      for (const logger of pendingWinstonLoggers) {
        addWinstonTransport(logger)
      }
      pendingWinstonLoggers.clear()
    })

    this.addSub('ci:log-submission:winston:add-transport', addWinstonTransport)

    this.addSub('ci:log-submission:log', (payload) => {
      this.#enqueueLog(payload)
    })

    this.addSub('ci:agentless:flush', ({ registerCompletion } = {}) => {
      this.#flushLogs(registerCompletion)
    })
  }

  /**
   * @param {boolean | (Record<string, unknown> & { enabled: boolean })} config
   * @returns {void}
   */
  configure (config) {
    if (this._enabled) this.#flushLogs()

    const isEnabled = typeof config === 'boolean' ? config : config.enabled
    this.#logSubmissionUrl = isEnabled && typeof config !== 'boolean'
      ? getLogSubmissionUrl(config)
      : undefined
    super.configure(config)

    const beforeExitHandlers = globalThis[Symbol.for('dd-trace')].beforeExitHandlers
    if (this._enabled) {
      beforeExitHandlers.add(this.#beforeExitHandler)
    } else {
      beforeExitHandlers.delete(this.#beforeExitHandler)
    }
  }

  /**
   * @param {{ source: string, message: string | Record<string, unknown> }} payload
   * @returns {void}
   */
  #enqueueLog ({ source, message }) {
    if (!this.#logSubmissionUrl) return

    let serializedMessage
    try {
      serializedMessage = typeof message === 'string' ? message : JSON.stringify(message)
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

    if (this.#batch.length > 0 &&
        (this.#batchSource !== source || this.#batchBytes + messageBytes + 1 > MAX_BATCH_BYTES)) {
      this.#flushLogs()
      if (!this.#logSubmissionUrl) return
    }

    this.#batchSource = source
    if (this.#batch.length > 0) this.#batchBytes++
    this.#batch.push(serializedMessage)
    this.#batchBytes += messageBytes

    if (this.#batch.length === MAX_BATCH_LOGS || this.#batchBytes === MAX_BATCH_BYTES) {
      this.#flushLogs()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => this.#flushLogs(), BATCH_FLUSH_INTERVAL)
      this.#timer.unref?.()
    }
  }

  /**
   * @param {(() => (() => void)) | undefined} registerCompletion
   * @returns {void}
   */
  #flushLogs (registerCompletion) {
    clearTimeout(this.#timer)
    this.#timer = undefined

    let requestData
    if (this.#batch.length > 0 && this.#logSubmissionUrl) {
      const source = this.#batchSource
      const data = `[${this.#batch.join(',')}]`
      this.#batch = []
      this.#batchBytes = 2
      this.#batchSource = undefined
      const options = {
        path: getLogSubmissionPath(this.config, source),
        method: 'POST',
        headers: {
          'DD-API-KEY': this.config.DD_API_KEY,
          'Content-Type': 'application/json',
        },
        url: this.#logSubmissionUrl,
      }
      const pendingRequest = { source }
      this.#pendingRequests.add(pendingRequest)
      requestData = { data, options, pendingRequest }
    }

    if (registerCompletion && this.#pendingRequests.size > 0) {
      this.#requestCompletions.push({
        complete: registerCompletion(),
        pendingRequests: new Set(this.#pendingRequests),
      })
    }

    if (!requestData) return

    const { data, options, pendingRequest } = requestData
    try {
      request(data, options, error => {
        this.#finishRequest(pendingRequest, error)
      })
    } catch (error) {
      this.#logSubmissionUrl = undefined
      this.#finishRequest(pendingRequest, error)
    }
  }

  /**
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
