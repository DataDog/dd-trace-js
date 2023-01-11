'use strict'

const dc = require('diagnostics_channel')

const Level = {
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error'
}

const defaultLogLevel = Level.Debug

// based on: https://github.com/trentm/node-bunyan#levels
const channels = {};
[Level.Debug, Level.Info, Level.Warn, Level.Error]
  .forEach((channelName, index) => {
    channels[channelName] = {
      ord: (index + 2) * 10,
      channel: dc.channel(`dd-trace:log:${channelName}`)
    }
  })

function publishChannel (channelName, message) {
  channels[channelName].channel.publish(message)
}

function getChannelLogLevel (logLevel) {
  let channel
  if (logLevel && typeof logLevel === 'string') {
    channel = channels[logLevel.toLowerCase().trim()] || channels[defaultLogLevel]
  } else {
    channel = channels[defaultLogLevel]
  }
  return channel.ord
}

function subscribe (listeners) {
  for (const channelName in listeners) {
    channels[channelName].channel.subscribe(listeners[channelName])
  }
}

function unsubscribe (listeners) {
  for (const channelName in listeners) {
    channels[channelName].channel.unsubscribe(listeners[channelName])
  }
}

module.exports = {
  Level,
  publishChannel,
  getChannelLogLevel,
  subscribe,
  unsubscribe
}
