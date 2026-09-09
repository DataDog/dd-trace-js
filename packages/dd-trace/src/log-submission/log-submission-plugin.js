'use strict'

const { Writable } = require('node:stream')

const FinalFlushRequestTracker = require('../exporters/common/final-flush-request-tracker')
const request = require('../exporters/common/request')
const log = require('../log')
const Plugin = require('../plugins/plugin')

const MAX_BATCH_BYTES = 5 * 1024 * 1024
const MAX_BATCH_LOGS = 1000
const BATCH_FLUSH_INTERVAL = 1000
const FINAL_FLUSH_TIMEOUT = 60_000

/**
 * @returns {Error & { code: string }}
 */
function createFinalFlushTimeoutError () {
  return Object.assign(
    new Error('Timed out waiting for automatic log submission to flush'),
    { code: 'ERR_DD_LOG_SUBMISSION_FLUSH_TIMEOUT' }
  )
}

/**
 * @param {import('../config/config-base')} config
 * @returns {URL | void}
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
 * @param {unknown} config
 * @returns {import('../config/config-base')}
 */
function asTracerConfig (config) {
  return /** @type {import('../config/config-base')} */ (config)
}

/**
 * @param {import('../config/config-base')} config
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
  /** @type {import('../config/config-base') | undefined} */
  #config
  #logSubmissionUrl
  #requestTracker
  #timer
  #beforeExitHandler = () => this.#flushLogs()
  #createWinstonJsonFormat
  #winstonStreamClass
  // Winston formats records inside its transports, not at logger.write time, so (unlike Bunyan/Pino)
  // the instrumentation can't publish a post-format line. A Stream transport pipes format.json()
  // output through this Writable into the shared sender, reusing Winston's own cycle-safe serializer.
  #winstonOutput = new Writable({
    decodeStrings: false,
    write: (message, encoding, callback) => {
      this.#enqueueLog({ source: 'winston', message })
      callback()
    },
  })

  /**
   * @param {object} tracer
   * @param {unknown} tracerConfig
   */
  constructor (tracer, tracerConfig) {
    super(tracer, asTracerConfig(tracerConfig))
    this.#requestTracker = new FinalFlushRequestTracker(
      (done) => {
        this.#flushLogs()
        done?.()
      },
      createFinalFlushTimeoutError
    )

    // The main-module hook (configure) and the logger.js hook (add-transport) can fire in either
    // order depending on how Winston is required, so buffer loggers that arrive before configure.
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
    this.addSub('ci:log-submission:flush', ({ onDone } = {}) => {
      if (!onDone) {
        this.#flushLogs()
        return
      }

      this.#requestTracker.flush(onDone, {
        deadline: Date.now() + FINAL_FLUSH_TIMEOUT,
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
    this.#config = isEnabled && typeof config !== 'boolean' ? asTracerConfig(config) : undefined
    this.#logSubmissionUrl = this.#config
      ? getLogSubmissionUrl(this.#config)
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
   * @returns {void}
   */
  #flushLogs () {
    clearTimeout(this.#timer)
    this.#timer = undefined

    const config = this.#config
    if (this.#batch.length === 0 || !this.#logSubmissionUrl || !config) return

    const source = this.#batchSource
    const data = `[${this.#batch.join(',')}]`
    this.#batch = []
    this.#batchBytes = 2
    this.#batchSource = undefined
    const options = {
      path: getLogSubmissionPath(config, source),
      method: 'POST',
      headers: {
        'DD-API-KEY': config.DD_API_KEY,
        'Content-Type': 'application/json',
      },
      url: this.#logSubmissionUrl,
    }

    try {
      this.#requestTracker.send(request, data, options, error => {
        if (error) log.error('Error submitting %s logs', source, error)
      })
    } catch (error) {
      this.#logSubmissionUrl = undefined
      log.error('Error submitting %s logs', source, error)
    }
  }
}

module.exports = LogSubmissionPlugin
