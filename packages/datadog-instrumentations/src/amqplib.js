'use strict'

const {
  addHook,
  TracingChannel
} = require('./helpers/instrument')
const kebabCase = require('lodash.kebabcase')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = new TracingChannel('apm:amqplib:command')

let methods = {}

addHook({ name: 'amqplib', file: 'lib/defs.js', versions: ['>=0.5'] }, defs => {
  methods = Object.keys(defs)
    .filter(key => Number.isInteger(defs[key]))
    .filter(key => isCamelCase(key))
    .reduce((acc, key) => Object.assign(acc, { [defs[key]]: kebabCase(key).replace('-', '.') }), {})
  return defs
})

addHook({ name: 'amqplib', file: 'lib/channel.js', versions: ['>=0.5'] }, channel => {
  shimmer.wrap(channel.Channel.prototype, 'sendImmediately', sendImmediately => function (method, fields) {
    return instrument(sendImmediately, this, arguments, methods[method], fields)
  })

  shimmer.wrap(channel.Channel.prototype, 'sendMessage', sendMessage => function (fields) {
    return instrument(sendMessage, this, arguments, 'basic.publish', fields)
  })

  shimmer.wrap(channel.BaseChannel.prototype, 'dispatchMessage', dispatchMessage => function (fields, message) {
    return instrument(dispatchMessage, this, arguments, 'basic.deliver', fields, message)
  })
  return channel
})

function instrument (send, channel, args, method, fields, message) {
  if (!tracingChannel.hasSubscribers) {
    return send.apply(channel, args)
  }

  return tracingChannel.trace(() => {
    return send.apply(channel, args)
  }, { channel, method, fields, message })
}

function isCamelCase (str) {
  return /([A-Z][a-z0-9]+)+/.test(str)
}
