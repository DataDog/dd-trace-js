'use strict'

const { LOG } = require('../../../../ext/formats')
const Plugin = require('./plugin')
const { storage } = require('../../../datadog-core')

const hasOwn = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop)

function messageProxy (message, holder) {
  return new Proxy(message, {
    get (target, p, receiver) {
      switch (p) {
        case Symbol.toStringTag:
          return Object.prototype.toString.call(target).slice(8, -1)
        case 'dd':
          return holder.dd
        default:
          return Reflect.get(target, p, receiver)
      }
    },
    ownKeys (target) {
      const ownKeys = Reflect.ownKeys(target)
      return hasOwn(target, 'dd') ? ownKeys : ['dd', ...ownKeys]
    },
    getOwnPropertyDescriptor (target, p) {
      return Reflect.getOwnPropertyDescriptor(p === 'dd' ? holder : target, p)
    }
  })
}

module.exports = class LogPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.constructor.name}:log`, (arg) => {
      const store = storage.getStore()
      const span = store && store.span

      if (!span) return

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
