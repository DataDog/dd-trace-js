'use strict'

const { LOG } = require('../../../../ext/formats')
const { storage } = require('../../../datadog-core')
const log = require('../log')
const Plugin = require('./plugin')

function messageProxy (message, holder) {
  return new Proxy(message, {
    get (target, key) {
      if (shouldOverride(target, key)) {
        return holder.dd
      }

      return target[key]
    },
    ownKeys (target) {
      const ownKeys = Reflect.ownKeys(target)
      if (!Object.hasOwn(target, 'dd') && Reflect.isExtensible(target)) {
        ownKeys.push('dd')
      }
      return ownKeys
    },
    getOwnPropertyDescriptor (target, p) {
      return Reflect.getOwnPropertyDescriptor(shouldOverride(target, p) ? holder : target, p)
    },
  })
}

function shouldOverride (target, p) {
  return p === 'dd' && !Object.hasOwn(target, p) && Reflect.isExtensible(target)
}

module.exports = class LogPlugin extends Plugin {
  #pinoTransport = undefined
  #pinoTransportCreated = false
  #injectedLoggers = new WeakSet()

  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.constructor.id}:log`, (arg) => {
      const span = storage('legacy').getStore()?.span

      // NOTE: This needs to run whether or not there is a span
      // so service, version, and env will always get injected.
      const holder = {}
      this.tracer.inject(span, LOG, holder)
      arg.message = messageProxy(arg.message, holder)
    })

    this.addSub('apm:winston:log-capture-add-transport', (logger) => {
      if (!this.#transportCaptureEnabled) return
      try {
        this.#injectWinstonHttpTransport(logger)
      } catch (err) {
        log.error('Failed to inject Winston HTTP transport: %s', err.message)
      }
    })

    this.addSub('ci:log-submission:bunyan:add-stream', (logger) => {
      if (!this.#transportCaptureEnabled) return
      try {
        this.#injectBunyanHttpStream(logger)
      } catch (err) {
        log.error('Failed to inject Bunyan HTTP stream: %s', err.message)
      }
    })

    this.addSub('ci:log-submission:pino:get-transport-config', (configPayload) => {
      if (!this.#transportCaptureEnabled) return
      try {
        if (!this.#pinoTransportCreated) {
          this.#pinoTransportCreated = true
          this.#pinoTransport = this.#createPinoHttpTransport()
        }
        configPayload.transport = this.#pinoTransport
      } catch (err) {
        log.error('Failed to create Pino HTTP transport: %s', err.message)
      }
    })
  }

  configure (config) {
    super.configure({
      ...config,
      enabled: config.enabled && (
        config.logInjection ||
        config.ciVisAgentlessLogSubmissionEnabled ||
        (config.logCaptureEnabled && config.logCaptureMethod === 'transport')
      ),
    })

    return this
  }

  /** @returns {boolean} */
  get #transportCaptureEnabled () {
    return this.config.logCaptureEnabled && this.config.logCaptureMethod === 'transport'
  }

  /**
   * Returns shared HTTP options for Bunyan and Pino, or undefined if host/port are not configured.
   * @returns {{ host: string, port: number, path: string, protocol: string,
   *   maxBufferSize: number, flushIntervalMs: number, timeout: number } | undefined}
   */
  #buildHttpOptions () {
    const { config } = this
    if (!config.logCaptureHost || !config.logCapturePort) return
    return {
      host: config.logCaptureHost,
      port: config.logCapturePort,
      path: config.logCapturePath || '/logs',
      protocol: config.logCaptureProtocol || 'http:',
      maxBufferSize: config.logCaptureMaxBufferSize || 1000,
      flushIntervalMs: config.logCaptureFlushIntervalMs || 5000,
      timeout: config.logCaptureTimeoutMs || 5000,
    }
  }

  /**
   * @param {object} logger - Winston logger instance
   */
  #injectWinstonHttpTransport (logger) {
    if (this.#injectedLoggers.has(logger)) {
      log.debug('Winston HTTP transport already injected for this logger instance')
      return
    }

    const { config } = this
    if (!config.logCaptureHost || !config.logCapturePort) {
      log.warn('Winston HTTP transport not injected: logCaptureHost or logCapturePort not configured')
      return
    }

    // eslint-disable-next-line import/no-extraneous-dependencies, n/no-extraneous-require
    const winston = require('winston')
    if (!winston.transports?.Http) {
      log.warn('Winston HTTP transport not available')
      return
    }

    logger.add(new winston.transports.Http({
      host: config.logCaptureHost,
      port: config.logCapturePort,
      path: config.logCapturePath || '/logs',
      ssl: config.logCaptureProtocol === 'https:',
      batch: true,
      batchInterval: config.logCaptureFlushIntervalMs || 5000,
      batchCount: config.logCaptureMaxBufferSize || 1000,
    }))
    this.#injectedLoggers.add(logger)
    log.debug('Winston HTTP transport injected: %s:%s%s',
      config.logCaptureHost, config.logCapturePort, config.logCapturePath || '/logs')
  }

  /**
   * @param {object} logger - Bunyan logger instance
   */
  #injectBunyanHttpStream (logger) {
    if (this.#injectedLoggers.has(logger)) {
      log.debug('Bunyan HTTP stream already injected for this logger instance')
      return
    }

    const options = this.#buildHttpOptions()
    if (!options) {
      log.warn('Bunyan HTTP stream not injected: logCaptureHost or logCapturePort not configured')
      return
    }

    const BunyanHttpStream = require('./bunyan_http_stream')
    logger.addStream({ type: 'raw', stream: new BunyanHttpStream(options), level: 'trace' })
    this.#injectedLoggers.add(logger)
    log.debug('Bunyan HTTP stream injected: %s:%s%s', options.host, options.port, options.path)
  }

  /**
   * @returns {import('node:stream').Writable | undefined}
   */
  #createPinoHttpTransport () {
    const options = this.#buildHttpOptions()
    if (!options) {
      log.warn('Pino HTTP transport not created: logCaptureHost or logCapturePort not configured')
      return
    }

    const transport = require('./pino_http_transport')(options)
    log.debug('Pino HTTP transport created: %s:%s%s', options.host, options.port, options.path)
    return transport
  }
}
