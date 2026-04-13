'use strict'

const { LOG } = require('../../../../ext/formats')
const { storage } = require('../../../datadog-core')
const log = require('../log')
const captureSender = require('../log-capture/sender')
const Plugin = require('./plugin')

function messageProxy (message, holder) {
  return new Proxy(message, {
    get (target, key) {
      if (shouldOverride(target, key)) {
        return holder.dd
      }

      return target[key]
    },
    set (target, key, value) {
      return Reflect.set(target, key, value)
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

    this.addSub(`apm:${this.constructor.id}:log`, (arg) => {
      const span = storage('legacy').getStore()?.span

      // NOTE: holder is always populated (service, version, env, and trace context if span active).
      const holder = {}
      this.tracer.inject(span, LOG, holder)

      // Expose holder on the payload so instrumentation can pipe it into the capture channel.
      arg.holder = holder

      // Only mutate the actual log record when log injection is requested.
      if (this.config.logInjection) {
        arg.message = messageProxy(arg.message, holder)
      }

      // Forward to capture sender.
      // Subclasses may override _captureEnabled to suppress this path
      // and handle capture via their own channel instead.
      if (this._captureEnabled) {
        try {
          // Always include dd trace context in captured records even if logInjection is off.
          const msg = this.config.logInjection ? arg.message : messageProxy(arg.message, holder)
          this.capture(JSON.stringify(msg))
        } catch (err) {
          log.debug('Log capture serialization error: %s', err.message)
        }
      }
    })
  }

  /**
   * Whether log capture is enabled for this plugin instance.
   * Subclasses may override this to return false and handle capture themselves
   * via a dedicated channel instead.
   *
   * @returns {boolean}
   */
  get _captureEnabled () {
    return !!this.config.logCaptureEnabled
  }

  /**
   * Forward a pre-serialized JSON log record to the capture sender.
   * Subclasses that handle their own serialization should call this instead of
   * accessing the sender module directly.
   *
   * @param {string} jsonStr Serialized JSON log record.
   * @returns {void}
   */
  capture (jsonStr) {
    captureSender.add(jsonStr)
  }

  configure (config) {
    super.configure({
      ...config,
      enabled: config.enabled && (
        config.logInjection ||
        config.ciVisAgentlessLogSubmissionEnabled ||
        config.logCaptureEnabled
      ),
    })

    return this
  }
}
