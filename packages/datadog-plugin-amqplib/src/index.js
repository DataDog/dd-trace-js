'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { tracer } = require('../../datadog-tracer')
const { TEXT_MAP } = require('../../../ext/formats')

const fieldNames = [
  'queue',
  'exchange',
  'routingKey',
  'consumerTag',
  'source',
  'destination'
]

class AmqplibPlugin extends Plugin {
  static get name () {
    return 'amqplib'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:amqplib:command:start`, ({ channel, method, fields, message }) => {
      fields.headers = fields.headers || {}

      const stream = channel && channel.connection && channel.connection.stream
      const childOf = method === 'basic.deliver' && extract(tracer, message)
      const span = this.startSpan('amqp.command', {
        childOf,
        service: this.config.service || `${tracer.config.service}-amqp`,
        resource: getResourceName(method, fields),
        kind: 'client',
        meta: stream ? {
          'out.host': stream._host,
          'out.port': String(stream.remotePort)
        } : {}
      })

      switch (method) {
        case 'basic.publish':
          span.kind = 'producer'
          tracer.inject(span, TEXT_MAP, fields.headers)
          break
        case 'basic.consume':
        case 'basic.get':
        case 'basic.deliver':
          span.type = 'worker'
          span.kind = 'consumer'
          break
      }

      for (const field of fieldNames) {
        span.setTag(`amqp.${field}`, fields[field])
      }
    })

    this.addSub(`apm:amqplib:command:end`, () => {
      this.finishSpan()
      this.exit()
    })

    this.addSub(`apm:amqplib:command:error`, err => {
      this.addError(err)
    })
  }
}

function getResourceName (method, fields = {}) {
  return [
    method,
    fields.exchange,
    fields.routingKey,
    fields.queue,
    fields.source,
    fields.destination
  ].filter(val => val).join(' ')
}

function extract (tracer, message) {
  return message
    ? tracer.extract(TEXT_MAP, message.properties.headers)
    : null
}

module.exports = AmqplibPlugin
