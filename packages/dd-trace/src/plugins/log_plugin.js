'use strict'

const { LOG } = require('../../../../ext/formats')
const Plugin = require('./plugin')
const { storage } = require('../../../datadog-core')
const { COMPONENT } = require('../constants')

const hasOwn = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop)

function messageProxy (message, holder) {
  return new Proxy(message, {
    get (target, p, receiver) {
      if (p === Symbol.toStringTag) {
        return Object.prototype.toString.call(target).slice(8, -1)
      }

      if (shouldOverride(target, p)) {
        return holder.dd
      }

      return Reflect.get(target, p, receiver)
    },
    ownKeys (target) {
      const ownKeys = Reflect.ownKeys(target)
      return hasOwn(target, 'dd') || !Reflect.isExtensible(target)
        ? ownKeys
        : ['dd', ...ownKeys]
    },
    getOwnPropertyDescriptor (target, p) {
      return Reflect.getOwnPropertyDescriptor(shouldOverride(target, p) ? holder : target, p)
    }
  })
}

function shouldOverride (target, p) {
  return p === 'dd' && !Reflect.has(target, p) && Reflect.isExtensible(target)
}

module.exports = class LogPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.constructor.name}:log`, (arg) => {
      const store = storage.getStore()
      const span = store && store.span

      if (!span) return

      if (this.constructor.name) {
        span.setTag(COMPONENT, this.constructor.name)
      }

      const holder = {}
      this.tracer.inject(span, LOG, holder)
      arg.message = messageProxy(arg.message, holder)
    })
  }

  configure (config) {
    return super.configure({
      ...config,
      enabled: config.enabled && config.logInjection
    })
  }
}
