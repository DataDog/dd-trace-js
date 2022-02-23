'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const kebabCase = require('lodash.kebabcase')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:amqplib:command:start')
const endCh = channel('apm:amqplib:command:end')
const errorCh = channel('apm:amqplib:command:error')

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
  if (!startCh.hasSubscribers) {
    return send.apply(this, arguments)
  }
  startCh.publish({ channel, method, fields, message })

  try {
    return send.apply(channel, args)
  } catch (err) {
    errorCh.publish(err)

    throw err
  } finally {
    endCh.publish(undefined)
  }
}

function isCamelCase (str) {
  return /([A-Z][a-z0-9]+)+/.test(str)
}
