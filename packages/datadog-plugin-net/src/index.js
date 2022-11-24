'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { COMPONENT } = require('../../dd-trace/src/constants')

class NetPlugin extends Plugin {
  static get name () {
    return 'net'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:net:ipc:start`, ({ options }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store

      const span = this.tracer.startSpan('ipc.connect', {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.name,
          'resource.name': options.path,
          'ipc.path': options.path,
          'span.kind': 'client',
          'service.name': this.config.service || this.tracer._service
        }
      })

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub(`apm:net:ipc:error`, errorHandler)

    this.addSub(`apm:net:ipc:finish`, defaultFinish)

    this.addSub(`apm:net:tcp:start`, ({ options }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store

      const host = options.host || 'localhost'
      const port = options.port || 0
      const family = options.family || 4

      const span = this.tracer.startSpan('tcp.connect', {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.name,
          'resource.name': [host, port].filter(val => val).join(':'),
          'tcp.remote.host': host,
          'tcp.remote.port': port,
          'tcp.family': `IPv${family}`,
          'out.host': host,
          'out.port': port,
          'span.kind': 'client',
          'service.name': this.config.service || this.tracer._service
        }
      })

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub(`apm:net:tcp:error`, errorHandler)

    this.addSub(`apm:net:tcp:finish`, defaultFinish)

    this.addSub(`apm:net:tcp:connection`, ({ socket }) => {
      const span = storage.getStore().span
      span.addTags({
        [COMPONENT]: this.constructor.name,
        'tcp.local.address': socket.localAddress,
        'tcp.local.port': socket.localPort
      })
    })
  }
}

function defaultFinish () {
  storage.getStore().span.finish()
}

function errorHandler (error) {
  storage.getStore().span.setTag('error', error)
}

module.exports = NetPlugin
