'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

class Amqp10Plugin extends Plugin {
  static get name () {
    return 'amqp10'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:amqp10:send:start', ({ link }) => {
      const address = getAddress(link)
      const target = getShortName(link)

      this.startSpan('amqp.send', {
        service: this.config.service || `${this.tracer.config.service}-amqp`,
        resource: ['send', target].filter(v => v).join(' '),
        kind: 'producer',
        meta: {
          'amqp.link.target.address': target,
          'amqp.link.role': 'sender',
          'amqp.link.name': link.name,
          'amqp.link.handle': link.handle,
          'amqp.connection.host': address.host,
          'amqp.connection.port': address.port,
          'amqp.connection.user': address.user,
          'out.host': address.host,
          'out.port': address.port
        }
      })
    })

    this.addSub(`apm:amqp10:send:end`, () => {
      this.exit()
    })

    this.addSub(`apm:amqp10:send:error`, err => {
      this.addError(err)
    })

    this.addSub(`apm:amqp10:send:async-end`, () => {
      this.finishSpan()
    })

    this.addSub(`apm:amqp10:receive:start`, ({ link }) => {
      const source = getShortName(link)
      const address = getAddress(link)

      this.startSpan('amqp.receive', {
        resource: ['receive', source].filter(v => v).join(' '),
        service: this.config.service || `${this.tracer.config.service}-amqp`,
        kind: 'consumer',
        type: 'worker',
        meta: {
          'amqp.link.source.address': source,
          'amqp.link.role': 'receiver',
          'amqp.link.name': link.name,
          'amqp.link.handle': link.handle,
          'amqp.connection.host': address.host,
          'amqp.connection.port': address.port,
          'amqp.connection.user': address.user
        }
      })
    })

    this.addSub(`apm:amqp10:receive:end`, () => {
      this.finishSpan()
    })

    this.addSub(`apm:amqp10:receive:error`, err => {
      this.addError()
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
