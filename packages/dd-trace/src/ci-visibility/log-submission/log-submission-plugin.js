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
function getBunyanLogSubmissionUrl (config) {
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

  const hostname = `http-intake.logs.${config.site}`
  try {
    const url = new URL(`https://${hostname}`)
    if (url.hostname === hostname.toLowerCase()) return url
  } catch {}

  log.error('Could not parse automatic log submission site: %s', config.site)
}

/**
 * @param {string} service
 * @returns {string}
 */
function getBunyanLogSubmissionPath (service) {
  return `/api/v2/logs?${new URLSearchParams({ ddsource: 'bunyan', service })}`
}

class LogSubmissionPlugin extends Plugin {
  static id = 'log-submission'

  /** @type {string[]} */
  #bunyanBatch = []
  #bunyanBatchBytes = 2
  #bunyanLogSubmissionUrl
  #bunyanTimer
  #beforeExitHandler = () => this.#flushBunyanLogs()

  constructor (...args) {
    super(...args)

    this.addSub('ci:log-submission:winston:configure', (httpClass) => {
      this.HttpClass = httpClass
    })

    this.addSub('ci:log-submission:winston:add-transport', (logger) => {
      logger.add(new this.HttpClass(getWinstonLogSubmissionParameters(this.config)))
    })

    this.addSub('ci:log-submission:bunyan:log', ({ message }) => {
      this.#enqueueBunyanLog(message)
    })
  }

  /**
   * @param {boolean | (Record<string, unknown> & { enabled: boolean })} config
   * @returns {void}
   */
  configure (config) {
    if (this._enabled) this.#flushBunyanLogs()

    const isEnabled = typeof config === 'boolean' ? config : config.enabled
    this.#bunyanLogSubmissionUrl = isEnabled && typeof config !== 'boolean'
      ? getBunyanLogSubmissionUrl(config)
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
   * @param {string | Record<string, unknown>} message
   * @returns {void}
   */
  #enqueueBunyanLog (message) {
    if (!this.#bunyanLogSubmissionUrl) return

    let serializedMessage
    try {
      serializedMessage = typeof message === 'string' ? message : JSON.stringify(message)
    } catch (error) {
      log.error('Could not serialize Bunyan log for automatic submission', error)
      return
    }
    if (serializedMessage === undefined) return

    const messageBytes = Buffer.byteLength(serializedMessage)
    if (messageBytes + 2 > MAX_BATCH_BYTES) {
      log.error('Could not submit Bunyan log because it exceeds the %d byte payload limit', MAX_BATCH_BYTES)
      return
    }

    if (this.#bunyanBatch.length > 0 && this.#bunyanBatchBytes + messageBytes + 1 > MAX_BATCH_BYTES) {
      this.#flushBunyanLogs()
    }

    if (this.#bunyanBatch.length > 0) this.#bunyanBatchBytes++
    this.#bunyanBatch.push(serializedMessage)
    this.#bunyanBatchBytes += messageBytes

    if (this.#bunyanBatch.length === MAX_BATCH_LOGS || this.#bunyanBatchBytes === MAX_BATCH_BYTES) {
      this.#flushBunyanLogs()
    } else if (this.#bunyanTimer === undefined) {
      this.#bunyanTimer = setTimeout(() => this.#flushBunyanLogs(), BATCH_FLUSH_INTERVAL)
      this.#bunyanTimer.unref?.()
    }
  }

  /**
   * @returns {void}
   */
  #flushBunyanLogs () {
    clearTimeout(this.#bunyanTimer)
    this.#bunyanTimer = undefined

    if (this.#bunyanBatch.length === 0 || !this.#bunyanLogSubmissionUrl) return

    const data = `[${this.#bunyanBatch.join(',')}]`
    this.#bunyanBatch = []
    this.#bunyanBatchBytes = 2
    const options = {
      path: getBunyanLogSubmissionPath(this.config.service),
      method: 'POST',
      headers: {
        'DD-API-KEY': this.config.DD_API_KEY,
        'Content-Type': 'application/json',
      },
      url: this.#bunyanLogSubmissionUrl,
    }

    try {
      request(data, options, error => {
        if (error) log.error('Error submitting Bunyan logs', error)
      })
    } catch (error) {
      log.error('Error submitting Bunyan logs', error)
    }
  }
}

module.exports = LogSubmissionPlugin
