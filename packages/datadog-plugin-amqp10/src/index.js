'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class Amqp10Plugin extends Plugin {
  static get name () {
    return 'amqp10'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:amqp10:send:start`, ({ link }) => {
      const address = getAddress(link)
      const target = getShortName(link)

      const store = storage.getStore()
      const childOf = store ? store.span : store

      const span = this.tracer.startSpan('amqp.send', {
        childOf,
        tags: {
          'resource.name': ['send', target].filter(v => v).join(' '),
          'span.kind': 'producer',
          'amqp.link.target.address': target,
          'amqp.link.role': 'sender',
          'out.host': address.host,
          'out.port': address.port,
          'service.name': this.config.service || `${this.tracer._service}-amqp`,
          'amqp.link.name': link.name,
          'amqp.link.handle': link.handle,
          'amqp.connection.host': address.host,
          'amqp.connection.port': address.port,
          'amqp.connection.user': address.user
        }
      })

      analyticsSampler.sample(span, this.config.measured)

      this.enter(span, store)
    })

    this.addSub(`apm:amqp10:send:error`, err => {
      const span = storage.getStore().span
      span.setTag('error', err)
    })

    this.addSub(`apm:amqp10:send:finish`, () => {
      const span = storage.getStore().span
      span.finish()
    })

    this.addSub(`apm:amqp10:receive:start`, ({ link }) => {
      const source = getShortName(link)
      const address = getAddress(link)

      const store = storage.getStore()
      const childOf = store ? store.span : store

      const span = this.tracer.startSpan('amqp.receive', {
        childOf,
        tags: {
          'resource.name': ['receive', source].filter(v => v).join(' '),
          'span.kind': 'consumer',
          'span.type': 'worker',
          'amqp.link.source.address': source,
          'amqp.link.role': 'receiver',
          'service.name': this.config.service || `${this.tracer._service}-amqp`,
          'amqp.link.name': link.name,
          'amqp.link.handle': link.handle,
          'amqp.connection.host': address.host,
          'amqp.connection.port': address.port,
          'amqp.connection.user': address.user
        }
      })

      analyticsSampler.sample(span, this.config.measured)

      this.enter(span, store)
    })

    this.addSub(`apm:amqp10:receive:finish`, () => {
      storage.getStore().span.finish()
    })

    this.addSub(`apm:amqp10:receive:error`, err => {
      const span = storage.getStore().span
      span.setTag('error', err)
    })
  }
}

function getShortName (link) {
  if (!link || !link.name) return null

  return link.name.split('_').slice(0, -1).join('_')
}

function getAddress (link) {
  if (!link || !link.session || !link.session.connection) return {}

  return link.session.connection.address || {}
}

module.exports = Amqp10Plugin
