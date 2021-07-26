'use strict'

// TODO: remove direct usage of the logger across the tracer
// TODO: refactor this and move to core

const {
  debugChannel,
  errorChannel,
  infoChannel,
  warningChannel
} = require('../../datadog-core')
const NoopSpan = require('./noop/span')

const _default = {
  debug: msg => console.debug(msg), /* eslint-disable-line no-console */
  info: msg => console.info(msg), /* eslint-disable-line no-console */
  warn: msg => console.warn(msg), /* eslint-disable-line no-console */
  error: msg => console.error(msg) /* eslint-disable-line no-console */
}

// based on: https://github.com/trentm/node-bunyan#levels
const _logLevels = {
  'debug': 20,
  'info': 30,
  'warn': 40,
  'error': 50
}

const _defaultLogLevel = 'debug'

const _checkLogLevel = (logLevel) => {
  if (logLevel && typeof logLevel === 'string') {
    return _logLevels[logLevel.toLowerCase().trim()] || _logLevels[_defaultLogLevel]
  }

  return _logLevels[_defaultLogLevel]
}

const memoize = func => {
  const cache = {}
  const memoized = function (key) {
    if (!cache[key]) {
      cache[key] = func.apply(this, arguments)
    }

    return cache[key]
  }

  return memoized
}

function processMsg (msg) {
  return typeof msg === 'function' ? msg() : msg
}

function withNoop (fn) {
  if (!log._tracer) {
    fn()
  } else {
    log._tracer.scope().activate(log._noopSpan(), fn)
  }
}

const log = {
  _isLogLevelEnabled (level) {
    return _logLevels[level] >= this._logLevel
  },

  use (logger) {
    if (logger && logger.debug instanceof Function && logger.error instanceof Function) {
      this._logger = logger
    }

    return this
  },

  toggle (enabled, logLevel, tracer) {
    this._enabled = enabled
    this._logLevel = _checkLogLevel(logLevel)
    this._tracer = tracer

    this._resetListeners()

    return this
  },

  _noopSpan () {
    if (!this.__noopSpan) {
      this.__noopSpan = new NoopSpan(this._tracer)
    }
    return this.__noopSpan
  },

  reset () {
    this._logger = _default
    this._enabled = false
    delete this._tracer
    delete this.__noopSpan
    this._deprecate = memoize((code, message) => {
      return this.warn(message)
    })
    this._logLevel = _checkLogLevel()
    this._resetListeners()

    return this
  },

  debug (message) {
    return this._log(debugChannel, message)
  },

  info (message) {
    return this._log(infoChannel, message)
  },

  warn (message) {
    return this._log(warningChannel, message)
  },

  error (err) {
    return this._log(errorChannel, err)
  },

  deprecate (code, message) {
    return this._deprecate(code, message)
  },

  _log (logChannel, message) {
    if (logChannel.hasSubscribers) {
      logChannel.publish(processMsg(message))
    }

    return this
  },

  _onDebug (message) {
    withNoop(() => log._logger.debug(message))

    return this
  },

  _onInfo (message) {
    if (!log._logger.info) return log._onDebug(message)

    withNoop(() => log._logger.info(message))

    return this
  },

  _onWarning (message) {
    if (!log._logger.warn) return log._onDebug(message)

    withNoop(() => log._logger.warn(message))

    return this
  },

  _onError (err) {
    if (err instanceof Function) {
      err = err()
    }

    if (typeof err !== 'object' || !err) {
      err = String(err)
    } else if (!err.stack) {
      err = String(err.message || err)
    }

    if (typeof err === 'string') {
      err = new Error(err)
    }

    withNoop(() => log._logger.error(err))

    return this
  },

  _resetListeners () {
    debugChannel.hasSubscribers && debugChannel.unsubscribe(this._onDebug)
    infoChannel.hasSubscribers && infoChannel.unsubscribe(this._onInfo)
    warningChannel.hasSubscribers && warningChannel.unsubscribe(this._onWarning)
    errorChannel.hasSubscribers && errorChannel.unsubscribe(this._onError)

    if (!this._enabled) return

    if (this._isLogLevelEnabled('debug')) {
      debugChannel.subscribe(this._onDebug)
    }

    if (this._isLogLevelEnabled('info')) {
      infoChannel.subscribe(this._onInfo)
    }

    if (this._isLogLevelEnabled('warn')) {
      warningChannel.subscribe(this._onWarning)
    }

    if (this._isLogLevelEnabled('error')) {
      errorChannel.subscribe(this._onError)
    }
  }
}

log.reset()

module.exports = log
