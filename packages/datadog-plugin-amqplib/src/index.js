'use strict'

const kebabCase = require('lodash.kebabcase')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { TEXT_MAP } = require('../../../ext/formats')

let methods = {}

function createWrapSendImmediately (tracer, config) {
  return function wrapSendImmediately (sendImmediately) {
    return function sendImmediatelyWithTrace (method, fields) {
      return sendWithTrace(sendImmediately, this, arguments, tracer, config, methods[method], fields)
    }
  }
}

function createWrapSendMessage (tracer, config) {
  return function wrapSendMessage (sendMessage) {
    return function sendMessageWithTrace (fields) {
      return sendWithTrace(sendMessage, this, arguments, tracer, config, 'basic.publish', fields)
    }
  }
}

function createWrapDispatchMessage (tracer, config) {
  return function wrapDispatchMessage (dispatchMessage) {
    return function dispatchMessageWithTrace (fields, message) {
      const childOf = extract(tracer, message)
      const span = tracer.startSpan('amqp.command', { childOf })

      addTags(this, tracer, config, span, 'basic.deliver', fields)

      analyticsSampler.sample(span, config.measured, true)

      tracer.scope().activate(span, () => {
        try {
          dispatchMessage.apply(this, arguments)
        } catch (e) {
          throw addError(span, e)
        } finally {
          span.finish()
        }
      })
    }
  }
}

function sendWithTrace (send, channel, args, tracer, config, method, fields) {
  const childOf = tracer.scope().active()
  const span = tracer.startSpan('amqp.command', { childOf })

  fields.headers = fields.headers || {}

  addTags(channel, tracer, config, span, method, fields)
  tracer.inject(span, TEXT_MAP, fields.headers)

  analyticsSampler.sample(span, config.measured)

  return tracer.scope().activate(span, () => {
    try {
      return send.apply(channel, args)
    } catch (e) {
      throw addError(span, e)
    } finally {
      span.finish()
    }
  })
}

function isCamelCase (str) {
  return /([A-Z][a-z0-9]+)+/.test(str)
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

function addError (span, error) {
  span.addTags({
    'error.type': error.name,
    'error.msg': error.message,
    'error.stack': error.stack
  })

  return error
}

function addTags (channel, tracer, config, span, method, fields) {
  const fieldNames = [
    'queue',
    'exchange',
    'routingKey',
    'consumerTag',
    'source',
    'destination'
  ]

  span.addTags({
    'service.name': config.service || `${tracer._service}-amqp`,
    'resource.name': getResourceName(method, fields)
  })

  if (channel && channel.connection && channel.connection.stream) {
    span.addTags({
      'out.host': channel.connection.stream._host,
      'out.port': channel.connection.stream.remotePort
    })
  }

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
}

function extract (tracer, message) {
  return message
    ? tracer.extract(TEXT_MAP, message.properties.headers)
    : null
}

module.exports = [
  {
    name: 'amqplib',
    file: 'lib/defs.js',
    versions: ['>=0.5'],
    patch (defs, tracer, config) {
      methods = Object.keys(defs)
        .filter(key => Number.isInteger(defs[key]))
        .filter(key => isCamelCase(key))
        .reduce((acc, key) => Object.assign(acc, { [defs[key]]: kebabCase(key).replace('-', '.') }), {})
    },
    unpatch (defs) {
      methods = {}
    }
  },
  {
    name: 'amqplib',
    file: 'lib/channel.js',
    versions: ['>=0.5'],
    patch (channel, tracer, config) {
      this.wrap(channel.Channel.prototype, 'sendImmediately', createWrapSendImmediately(tracer, config))
      this.wrap(channel.Channel.prototype, 'sendMessage', createWrapSendMessage(tracer, config))
      this.wrap(channel.BaseChannel.prototype, 'dispatchMessage', createWrapDispatchMessage(tracer, config))
    },
    unpatch (channel) {
      this.unwrap(channel.Channel.prototype, 'sendImmediately')
      this.unwrap(channel.Channel.prototype, 'sendMessage')
      this.unwrap(channel.BaseChannel.prototype, 'dispatchMessage')
    }
  }
]
