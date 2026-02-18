'use strict'

const { LOG } = require('../../../../ext/formats')
const { storage } = require('../../../datadog-core')
const { channel } = require('dc-polyfill')
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
  constructor (...args) {
    super(...args)

    // Track loggers that have already had transports injected
    this._injectedLoggers = new WeakSet()

    this.addSub(`apm:${this.constructor.id}:log`, (arg) => {
      const span = storage('legacy').getStore()?.span

      // NOTE: This needs to run whether or not there is a span
      // so service, version, and env will always get injected.
      const holder = {}
      this.tracer.inject(span, LOG, holder)
      arg.message = messageProxy(arg.message, holder)
    })
  }

  configure (config) {
    super.configure({
      ...config,
      enabled: config.enabled && (config.logInjection || config.ciVisAgentlessLogSubmissionEnabled),
    })

    log.debug('LogPlugin.configure called')
    log.debug('  this.config.enabled:', this.config.enabled)
    log.debug('  config.logCaptureEnabled:', config.logCaptureEnabled)
    log.debug('  config.logCaptureMethod:', config.logCaptureMethod)
    log.debug('  config.logInjection:', config.logInjection)

    // Initialize transport/stream injection if enabled
    if (this.config.enabled && config.logCaptureEnabled && config.logCaptureMethod === 'transport') {
      log.info('Conditions met for logger transport/stream injection')
      this._initializeWinstonTransport(config)
      this._initializeBunyanStream(config)
      this._initializePinoTransport(config)
    } else {
      log.debug('Transport/stream injection NOT initialized:')
      log.debug('  plugin enabled:', this.config.enabled)
      log.debug('  logCaptureEnabled:', config.logCaptureEnabled)
      log.debug('  logCaptureMethod:', config.logCaptureMethod)
    }

    return this
  }

  /**
   * Initialize Winston HTTP transport injection
   * Subscribes to the winston add-transport channel and injects HTTP transport
   * @param {object} config - Tracer configuration
   */
  _initializeWinstonTransport (config) {
    const addTransportCh = channel('ci:log-submission:winston:add-transport')

    log.info('Initializing Winston HTTP transport injection')
    log.info('  Channel hasSubscribers:', addTransportCh.hasSubscribers)

    // Only subscribe once
    if (this._winstonTransportSubscribed) {
      log.debug('Winston transport already subscribed')
      return
    }
    this._winstonTransportSubscribed = true

    addTransportCh.subscribe((logger) => {
      log.info('Winston logger received via channel, attempting to inject HTTP transport')
      try {
        this._injectWinstonHttpTransport(logger, config)
      } catch (err) {
        log.error('Failed to inject Winston HTTP transport: %s', err.message)
      }
    })

    log.info('Winston HTTP transport subscription active, hasSubscribers:', addTransportCh.hasSubscribers)
  }

  /**
   * Inject Winston HTTP transport into the logger
   * @param {object} logger - Winston logger instance
   * @param {object} config - Tracer configuration
   */
  _injectWinstonHttpTransport (logger, config) {
    // Prevent duplicate injection
    if (this._injectedLoggers.has(logger)) {
      log.debug('Winston HTTP transport already injected for this logger instance')
      return
    }

    // Validate configuration
    if (!config.logCaptureHost || !config.logCapturePort) {
      log.warn('Winston HTTP transport not injected: logCaptureHost or logCapturePort not configured')
      return
    }

    // Lazy require winston to avoid dependency issues
    let winston
    try {
      winston = require('winston')
    } catch {
      log.debug('Winston not available, skipping HTTP transport injection')
      return
    }

    // Check if HTTP transport is available
    if (!winston.transports || !winston.transports.Http) {
      log.warn('Winston HTTP transport not available')
      return
    }

    // Create HTTP transport with configuration
    const httpTransport = new winston.transports.Http({
      host: config.logCaptureHost,
      port: config.logCapturePort,
      path: config.logCapturePath || '/logs',
      ssl: config.logCaptureProtocol === 'https:',
      batch: true,
      batchInterval: config.logCaptureFlushIntervalMs || 5000,
      batchCount: config.logCaptureMaxBufferSize || 1000,
    })

    // Add transport to logger
    logger.add(httpTransport)

    // Mark this logger as injected
    this._injectedLoggers.add(logger)

    log.info('Winston HTTP transport injected: %s:%s%s',
      config.logCaptureHost,
      config.logCapturePort,
      config.logCapturePath || '/logs'
    )
  }

  /**
   * Initialize Bunyan HTTP stream injection
   * Subscribes to the bunyan add-stream channel and injects HTTP stream
   * @param {object} config - Tracer configuration
   */
  _initializeBunyanStream (config) {
    const addStreamCh = channel('ci:log-submission:bunyan:add-stream')

    log.info('Initializing Bunyan HTTP stream injection')
    log.info('  Channel hasSubscribers:', addStreamCh.hasSubscribers)

    // Only subscribe once
    if (this._bunyanStreamSubscribed) {
      log.debug('Bunyan stream already subscribed')
      return
    }
    this._bunyanStreamSubscribed = true

    addStreamCh.subscribe((logger) => {
      log.info('Bunyan logger received via channel, attempting to inject HTTP stream')
      try {
        this._injectBunyanHttpStream(logger, config)
      } catch (err) {
        log.error('Failed to inject Bunyan HTTP stream: %s', err.message)
      }
    })

    log.info('Bunyan HTTP stream subscription active, hasSubscribers:', addStreamCh.hasSubscribers)
  }

  /**
   * Inject Bunyan HTTP stream into the logger
   * @param {object} logger - Bunyan logger instance
   * @param {object} config - Tracer configuration
   */
  _injectBunyanHttpStream (logger, config) {
    // Prevent duplicate injection
    if (this._injectedLoggers.has(logger)) {
      log.debug('Bunyan HTTP stream already injected for this logger instance')
      return
    }

    // Validate configuration
    if (!config.logCaptureHost || !config.logCapturePort) {
      log.warn('Bunyan HTTP stream not injected: logCaptureHost or logCapturePort not configured')
      return
    }

    // Create HTTP stream
    const BunyanHttpStream = require('./bunyan_http_stream')
    const httpStream = new BunyanHttpStream({
      host: config.logCaptureHost,
      port: config.logCapturePort,
      path: config.logCapturePath || '/logs',
      protocol: config.logCaptureProtocol || 'http:',
      maxBufferSize: config.logCaptureMaxBufferSize || 1000,
      flushIntervalMs: config.logCaptureFlushIntervalMs || 5000,
      timeout: config.logCaptureTimeout || 5000,
    })

    // Add stream to logger
    logger.addStream({
      type: 'raw', // Raw stream receives objects, not strings
      stream: httpStream,
      level: 'trace', // Capture all log levels
    })

    // Mark this logger as injected
    this._injectedLoggers.add(logger)

    log.info('Bunyan HTTP stream injected: %s:%s%s',
      config.logCaptureHost,
      config.logCapturePort,
      config.logCapturePath || '/logs'
    )
  }

  /**
   * Initialize Pino HTTP transport injection
   * Subscribes to the pino transport config channel and provides HTTP transport
   * @param {object} config - Tracer configuration
   */
  _initializePinoTransport (config) {
    const transportConfigCh = channel('ci:log-submission:pino:get-transport-config')

    log.info('Initializing Pino HTTP transport injection')
    log.info('  Channel hasSubscribers:', transportConfigCh.hasSubscribers)

    // Only subscribe once
    if (this._pinoTransportSubscribed) {
      log.debug('Pino transport already subscribed')
      return
    }
    this._pinoTransportSubscribed = true

    transportConfigCh.subscribe((configPayload) => {
      log.info('Pino requesting transport config, providing HTTP transport')
      try {
        const transport = this._createPinoHttpTransport(config)
        configPayload.transport = transport
      } catch (err) {
        log.error('Failed to create Pino HTTP transport: %s', err.message)
      }
    })

    log.info('Pino HTTP transport subscription active, hasSubscribers:', transportConfigCh.hasSubscribers)
  }

  /**
   * Create Pino HTTP transport stream
   * @param {object} config - Tracer configuration
   * @returns {import('stream').Transform} Pino transport stream
   */
  _createPinoHttpTransport (config) {
    // Validate configuration
    if (!config.logCaptureHost || !config.logCapturePort) {
      log.warn('Pino HTTP transport not created: logCaptureHost or logCapturePort not configured')
      return null
    }

    const pinoHttpTransport = require('./pino_http_transport')
    const transport = pinoHttpTransport({
      host: config.logCaptureHost,
      port: config.logCapturePort,
      path: config.logCapturePath || '/logs',
      protocol: config.logCaptureProtocol || 'http:',
      maxBufferSize: config.logCaptureMaxBufferSize || 1000,
      flushIntervalMs: config.logCaptureFlushIntervalMs || 5000,
      timeout: config.logCaptureTimeout || 5000,
    })

    log.info('Pino HTTP transport created: %s:%s%s',
      config.logCaptureHost,
      config.logCapturePort,
      config.logCapturePath || '/logs'
    )

    return transport
  }
}
