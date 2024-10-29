'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const kebabCase = require('../../datadog-core/src/utils/src/kebabcase')
const shimmer = require('../../datadog-shimmer')

const { NODE_MAJOR, NODE_MINOR } = require('../../../version')
const MIN_VERSION = ((NODE_MAJOR > 22) || (NODE_MAJOR === 22 && NODE_MINOR >= 2)) ? '>=0.5.3' : '>=0.5.0'

const startCh = channel('apm:amqplib:command:start')
const finishCh = channel('apm:amqplib:command:finish')
const errorCh = channel('apm:amqplib:command:error')

let methods = {}

addHook({ name: 'amqplib', file: 'lib/defs.js', versions: [MIN_VERSION] }, defs => {
  methods = Object.keys(defs)
    .filter(key => Number.isInteger(defs[key]))
    .filter(key => isCamelCase(key))
    .reduce((acc, key) => Object.assign(acc, { [defs[key]]: kebabCase(key).replace('-', '.') }), {})
  return defs
})

addHook({ name: 'amqplib', file: 'lib/channel_model.js', versions: [MIN_VERSION] }, x => {
  shimmer.wrap(x.Channel.prototype, 'get', getMessage => function (queue, options) {
    return getMessage.apply(this, arguments).then(message => {
      if (message === null) {
        return message
      }
      startCh.publish({ method: 'basic.get', message, fields: message.fields, queue })
      // finish right away
      finishCh.publish()
      return message
    })
  })
  shimmer.wrap(x.Channel.prototype, 'consume', consume => function (queue, callback, options) {
    if (!startCh.hasSubscribers) {
      return consume.apply(this, arguments)
    }
    arguments[1] = (message, ...args) => {
      if (message === null) {
        return callback(message, ...args)
      }
      startCh.publish({ method: 'basic.deliver', message, fields: message.fields, queue })
      const result = callback(message, ...args)
      finishCh.publish()
      return result
    }
    return consume.apply(this, arguments)
  })
  return x
})

addHook({ name: 'amqplib', file: 'lib/callback_model.js', versions: [MIN_VERSION] }, channel => {
  shimmer.wrap(channel.Channel.prototype, 'get', getMessage => function (queue, options, callback) {
    if (!startCh.hasSubscribers) {
      return getMessage.apply(this, arguments)
    }
    arguments[2] = (error, message, ...args) => {
      if (error !== null || message === null) {
        return callback(error, message, ...args)
      }
      startCh.publish({ method: 'basic.get', message, fields: message.fields, queue })
      const result = callback(error, message, ...args)
      finishCh.publish()
      return result
    }
    return getMessage.apply(this, arguments)
  })
  shimmer.wrap(channel.Channel.prototype, 'consume', consume => function (queue, callback) {
    if (!startCh.hasSubscribers) {
      return consume.apply(this, arguments)
    }
    arguments[1] = (message, ...args) => {
      if (message === null) {
        return callback(message, ...args)
      }
      startCh.publish({ method: 'basic.deliver', message, fields: message.fields, queue })
      const result = callback(message, ...args)
      finishCh.publish()
      return result
    }
    return consume.apply(this, arguments)
  })
  return channel
})

addHook({ name: 'amqplib', file: 'lib/channel.js', versions: [MIN_VERSION] }, channel => {
  shimmer.wrap(channel.Channel.prototype, 'sendImmediately', sendImmediately => function (method, fields) {
    return instrument(sendImmediately, this, arguments, methods[method], fields)
  })

  shimmer.wrap(channel.Channel.prototype, 'sendMessage', sendMessage => function (fields) {
    return instrument(sendMessage, this, arguments, 'basic.publish', fields, arguments[2])
  })
  return channel
})

function instrument (send, channel, args, method, fields, message) {
  if (!startCh.hasSubscribers || method === 'basic.get') {
    return send.apply(channel, args)
  }

  const asyncResource = new AsyncResource('bound-anonymous-fn')
  return asyncResource.runInAsyncScope(() => {
    startCh.publish({ channel, method, fields, message })

    try {
      return send.apply(channel, args)
    } catch (err) {
      errorCh.publish(err)

      throw err
    } finally {
      finishCh.publish()
    }
  })
}

function isCamelCase (str) {
  return /([A-Z][a-z0-9]+)+/.test(str)
}
