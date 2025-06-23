'use strict'

const { LOG } = require('../../../../ext/formats')
const Plugin = require('./plugin')
const { storage } = require('../../../datadog-core')

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
    }
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

      // NOTE: This needs to run whether or not there is a span
      // so service, version, and env will always get injected.
      const holder = {}
      this.tracer.inject(span, LOG, holder)
      arg.message = messageProxy(arg.message, holder)
    })
  }

  _isEnabled (config) {
    return config.enabled && (config.logInjection === true || config.ciVisAgentlessLogSubmissionEnabled)
  }

  configure (config) {
    return super.configure({
      ...config,
      enabled: this._isEnabled(config)
    })
  }
}
