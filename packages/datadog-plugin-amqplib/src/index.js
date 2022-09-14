'use strict'

const { Plugin, TracingSubscription } = require('../../dd-trace/src/plugins/plugin')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { TEXT_MAP } = require('../../../ext/formats')

class AmqplibCommandSubscription extends TracingSubscription {
  prefix = 'apm:amqplib:command'

  start ({ channel, method, fields, message }, store) {
    let childOf

    if (method === 'basic.deliver') {
      childOf = extract(this.plugin.tracer, message)
    } else {
      fields.headers = fields.headers || {}
      childOf = store ? store.span : store
    }

    const span = this.plugin.tracer.startSpan('amqp.command', {
      childOf,
      tags: {
        'service.name': this.plugin.config.service || `${this.plugin.tracer._service}-amqp`,
        'resource.name': getResourceName(method, fields)
      }
    })

    if (channel && channel.connection && channel.connection.stream) {
      span.addTags({
        'out.host': channel.connection.stream._host,
        'out.port': channel.connection.stream.remotePort
      })
    }
    const fieldNames = [
      'queue',
      'exchange',
      'routingKey',
      'consumerTag',
      'source',
      'destination'
    ]

    switch (method) {
      case 'basic.publish':
        span.setTag('span.kind', 'producer')
        break
      case 'basic.consume':
      case 'basic.get':
      case 'basic.deliver':
        span.addTags({
          'span.kind': 'consumer',
          'span.type': 'worker'
        })
        break
      default:
        span.setTag('span.kind', 'client')
    }

    fieldNames.forEach(field => {
      fields[field] !== undefined && span.setTag(`amqp.${field}`, fields[field])
    })
    if (method === 'basic.deliver') {
      analyticsSampler.sample(span, this.plugin.config.measured, true)
    } else {
      this.plugin.tracer.inject(span, TEXT_MAP, fields.headers)
      analyticsSampler.sample(span, this.plugin.config.measured)
    }

    return span
  }

  end (ctx) {
    ctx.span.finish()
  }
}

class AmqplibPlugin extends Plugin {
  tracingSubscriptions = [AmqplibCommandSubscription]

  static get name () {
    return 'amqplib'
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
