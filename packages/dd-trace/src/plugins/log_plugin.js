'use strict'

const { LOG } = require('../../../../ext/formats')
const Plugin = require('./plugin')
const { storage } = require('../../../datadog-core')

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

    this.addSub(`apm:${this.constructor.id}:log`, (arg) => {
      const store = storage.getStore()
      const span = store && store.span

      // NOTE: This needs to run whether or not there is a span
      // so service, version, and env will always get injected.
      const holder = {}
      this.tracer.inject(span, LOG, holder)
      arg.message = messageProxy(arg.message, holder)
    })
    // TODO: create a different pluginf or this
    // probably good idea to do it in a _different_ plugin specific to ci vis
    this.addSub(`ci:${this.constructor.id}:configure`, (httpClass) => {
      if (!this.isCiVisAgentlessLogSubmissionEnabled) {
        return
      }
      this.HttpClass = httpClass
    })

    this.addSub(`ci:${this.constructor.id}:add-transport`, (logger) => {
      if (!this.isCiVisAgentlessLogSubmissionEnabled) {
        return
      }
      // TODO: change site, ddsource and service
      const httpTransportOptions = {
        host: 'http-intake.logs.datad0g.com',
        path: `/api/v2/logs?dd-api-key=${process.env.DD_API_KEY}&ddsource=nodejs&service=nodejs-example`,
        ssl: true
      }
      logger.add(new this.HttpClass(httpTransportOptions))
    })
  }

  configure (config) {
    this.isCiVisAgentlessLogSubmissionEnabled = config.ciVisAgentlessLogSubmissionEnabled
    return super.configure({
      ...config,
      enabled: config.enabled && (config.logInjection || config.ciVisAgentlessLogSubmissionEnabled)
    })
  }
}
