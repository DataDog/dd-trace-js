'use strict'

const request = require('../../exporters/common/request')
const log = require('../../log')
const Plugin = require('../../plugins/plugin')

const MAX_BATCH_BYTES = 5 * 1024 * 1024
const MAX_BATCH_LOGS = 1000
const BATCH_FLUSH_INTERVAL = 1000

function getWinstonLogSubmissionParameters (config) {
  const { site, service, DD_API_KEY, DD_AGENTLESS_LOG_SUBMISSION_URL } = config

  const defaultParameters = {
    host: `http-intake.logs.${site}`,
    path: `/api/v2/logs?ddsource=winston&service=${service}`,
    ssl: true,
    headers: {
      'DD-API-KEY': DD_API_KEY,
    },
  }

  if (!DD_AGENTLESS_LOG_SUBMISSION_URL) {
    return defaultParameters
  }

  try {
    const url = new URL(DD_AGENTLESS_LOG_SUBMISSION_URL)
    return {
      host: url.hostname,
      port: url.port,
      ssl: url.protocol === 'https:',
      path: defaultParameters.path,
      headers: defaultParameters.headers,
    }
  } catch {
    log.error('Could not parse DD_AGENTLESS_LOG_SUBMISSION_URL')
    return defaultParameters
  }
}

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

/**
 * @typedef {object} PendingLogRequest
 * @property {string} source
 */

/**
 * @typedef {object} LogRequestCompletion
 * @property {() => void} complete
 * @property {Set<PendingLogRequest>} pendingRequests
 */

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

  constructor (...args) {
    super(...args)

    this.addSub('ci:log-submission:winston:configure', (httpClass) => {
      this.HttpClass = httpClass
    })

    this.addSub('ci:log-submission:winston:add-transport', (logger) => {
      logger.add(new this.HttpClass(getWinstonLogSubmissionParameters(this.config)))
    })

    this.addSub('ci:log-submission:log', (payload) => {
      this.#enqueueLog(payload)
    })
    this.addSub('ci:agentless:flush', ({ registerCompletion } = {}) => {
      this.#flushLogs()
      if (!registerCompletion || this.#pendingRequests.size === 0) return

      this.#requestCompletions.push({
        complete: registerCompletion(),
        pendingRequests: new Set(this.#pendingRequests),
      })
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
   * @returns {void}
   */
  #flushLogs () {
    clearTimeout(this.#timer)
    this.#timer = undefined

    if (this.#batch.length === 0 || !this.#logSubmissionUrl) return

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
    try {
      request(data, options, error => this.#finishRequest(pendingRequest, error))
    } catch (error) {
      this.#logSubmissionUrl = undefined
      this.#finishRequest(pendingRequest, error)
    }
  }

  /**
   * Drops a finished intake request and releases flushes that were waiting for it.
   *
   * @param {PendingLogRequest} pendingRequest
   * @param {Error | null | undefined} error
   * @returns {void}
   */
  #finishRequest (pendingRequest, error) {
    if (!this.#pendingRequests.delete(pendingRequest)) return

    if (error) log.error('Error submitting %s logs', pendingRequest.source, error)

    const remaining = []
    for (const requestCompletion of this.#requestCompletions) {
      requestCompletion.pendingRequests.delete(pendingRequest)
      if (requestCompletion.pendingRequests.size === 0) {
        requestCompletion.complete()
      } else {
        remaining.push(requestCompletion)
      }
    }
    this.#requestCompletions = remaining
  }
}

module.exports = LogSubmissionPlugin
