'use strict'

const kebabCase = require('lodash.kebabcase')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

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
      const span = tracer.startSpan('amqp.command')

      addTags(this, tracer, config, span, 'basic.deliver', fields)

      analyticsSampler.sample(span, config.analytics, true)

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

  addTags(channel, tracer, config, span, method, fields)

  analyticsSampler.sample(span, config.analytics)

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
    'resource.name': getResourceName(method, fields),
    'span.type': 'worker'
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
      span.setTag('span.kind', 'consumer')
      break
  }

  fieldNames.forEach(field => {
    fields[field] !== undefined && span.setTag(`amqp.${field}`, fields[field])
  })
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
