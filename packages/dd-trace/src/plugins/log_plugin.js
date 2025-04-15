'use strict'

const { LOG } = require('../../../../ext/formats')
const Plugin = require('./plugin')
const { storage } = require('../../../datadog-core')

const hasOwn = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop)

function messageProxy (message, holder, constructorId) {
  // Only apply special stack handling for Winston to avoid breaking other plugins
  const isWinston = constructorId === 'winston'
  const originalStack = isWinston && message && typeof message === 'object' &&
    (message instanceof Error || message.stack)
    ? message.stack
    : undefined

  return new Proxy(message, {
    get (target, p, receiver) {
      if (p === Symbol.toStringTag) {
        return Object.prototype.toString.call(target).slice(8, -1)
      }

      if (shouldOverride(target, p)) {
        return holder.dd
      }

      // Special handling for Error stack property in Node.js 22
      if (p === 'stack' && originalStack !== undefined) {
        return originalStack
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
      // explicit handling for stack property descriptor for Node.js 22
      if (p === 'stack' && originalStack !== undefined) {
        return {
          value: originalStack,
          writable: true,
          enumerable: false,
          configurable: true
        }
      }
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

    this.addSub(`apm:${this.constructor.id}:log`, (arg) => {
      const store = storage('legacy').getStore()
      const span = store && store.span

      // NOTE: This needs to run whether or not there is a span
      // so service, version, and env will always get injected.
      const holder = {}
      this.tracer.inject(span, LOG, holder)
      arg.message = messageProxy(arg.message, holder, this.constructor.id)
    })
  }

  configure (config) {
    return super.configure({
      ...config,
      enabled: config.enabled && (config.logInjection || config.ciVisAgentlessLogSubmissionEnabled)
    })
  }
}
