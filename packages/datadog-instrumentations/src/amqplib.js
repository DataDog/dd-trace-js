'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const kebabCase = require('../../datadog-core/src/utils/src/kebabcase')
const shimmer = require('../../datadog-shimmer')

const { NODE_MAJOR, NODE_MINOR } = require('../../../version')
const MIN_VERSION = ((NODE_MAJOR > 22) || (NODE_MAJOR === 22 && NODE_MINOR >= 2)) ? '>=0.5.3' : '>=0.5.0'

const commandStartCh = channel('apm:amqplib:command:start')
const commandFinishCh = channel('apm:amqplib:command:finish')
const commandErrorCh = channel('apm:amqplib:command:error')

const consumeStartCh = channel('apm:amqplib:consume:start')
const consumeFinishCh = channel('apm:amqplib:consume:finish')

const publishStartCh = channel('apm:amqplib:publish:start')
const publishFinishCh = channel('apm:amqplib:publish:finish')
const publishErrorCh = channel('apm:amqplib:publish:error')

const methods = {}

addHook({ name: 'amqplib', file: 'lib/defs.js', versions: [MIN_VERSION] }, defs => {
  for (const [key, value] of Object.entries(defs)) {
    if (Number.isInteger(value) && isCamelCase(key)) {
      methods[value] = kebabCase(key).replaceAll('-', '.')
    }
  }
  return defs
})

addHook({ name: 'amqplib', file: 'lib/channel_model.js', versions: [MIN_VERSION] }, x => {
  shimmer.wrap(x.Channel.prototype, 'get', getMessage => function (queue, options) {
    return getMessage.apply(this, arguments).then(message => {
      if (message === null) {
        return message
      }
      const ctx = { method: 'basic.get', message, fields: message.fields, queue }
      consumeStartCh.runStores(ctx, () => {
        // finish right away
        consumeFinishCh.publish(ctx)
      })
      return message
    })
  })
  shimmer.wrap(x.Channel.prototype, 'consume', consume => function (queue, callback, options) {
    if (!consumeStartCh.hasSubscribers) {
      return consume.apply(this, arguments)
    }
    arguments[1] = (message, ...args) => {
      if (message === null) {
        return callback(message, ...args)
      }
      const ctx = { method: 'basic.deliver', message, fields: message.fields, queue }
      return consumeStartCh.runStores(ctx, () => {
        // finish right away
        const result = callback(message, ...args)
        consumeFinishCh.publish(ctx)
        return result
      })
    }
    return consume.apply(this, arguments)
  })
  return x
})

addHook({ name: 'amqplib', file: 'lib/callback_model.js', versions: [MIN_VERSION] }, channel => {
  shimmer.wrap(channel.Channel.prototype, 'get', getMessage => function (queue, options, callback) {
    if (!commandStartCh.hasSubscribers) {
      return getMessage.apply(this, arguments)
    }
    arguments[2] = (error, message, ...args) => {
      if (error !== null || message === null) {
        return callback(error, message, ...args)
      }
      const ctx = { method: 'basic.get', message, fields: message.fields, queue }
      return consumeStartCh.runStores(ctx, () => {
        const result = callback(error, message, ...args)
        consumeFinishCh.publish(ctx)
        return result
      })
    }
    return getMessage.apply(this, arguments)
  })
  shimmer.wrap(channel.Channel.prototype, 'consume', consume => function (queue, callback) {
    if (!consumeStartCh.hasSubscribers) {
      return consume.apply(this, arguments)
    }
    arguments[1] = (message, ...args) => {
      if (message === null) {
        return callback(message, ...args)
      }
      const ctx = { method: 'basic.deliver', message, fields: message.fields, queue }
      return consumeStartCh.runStores(ctx, () => {
        const result = callback(message, ...args)
        consumeFinishCh.publish(ctx)
        return result
      })
    }
    return consume.apply(this, arguments)
  })
  return channel
})

addHook({ name: 'amqplib', file: 'lib/channel.js', versions: [MIN_VERSION] }, channel => {
  shimmer.wrap(channel.Channel.prototype, 'sendImmediately', sendImmediately => function (method, fields) {
    return instrument(
      sendImmediately, this, arguments, methods[method], fields, null, commandStartCh, commandFinishCh, commandErrorCh
    )
  })

  shimmer.wrap(channel.Channel.prototype, 'sendMessage', sendMessage => function (fields) {
    return instrument(
      sendMessage, this, arguments, 'basic.publish', fields, arguments[2],
      publishStartCh, publishFinishCh, publishErrorCh
    )
  })
  return channel
})

function instrument (send, channel, args, method, fields, message, startCh, finishCh, errorCh) {
  if (!startCh.hasSubscribers || method === 'basic.get') {
    return send.apply(channel, args)
  }

  const ctx = { channel, method, fields, message }
  return startCh.runStores(ctx, () => {
    try {
      return send.apply(channel, args)
    } catch (err) {
      ctx.error = err
      errorCh.publish(ctx)

      throw err
    } finally {
      finishCh.publish(ctx)
    }
  })
}

function isCamelCase (str) {
  return /([A-Z][a-z0-9]+)+/.test(str)
}
