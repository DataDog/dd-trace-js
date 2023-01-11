'use strict'

const dc = require('diagnostics_channel')

const Level = {
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error'
}

const _defaultLevel = Level.Debug

class LogLevel {
  constructor (name, logLevel) {
    this.name = name
    this.logLevel = logLevel
    this.channel = dc.channel(`dd-trace:log:${name}`)
  }

  publish (message) {
    if (this.channel.hasSubscribers) {
      return this.channel.publish(message)
    }
  }

  subscribe (onMessage) {
    this.channel.subscribe(onMessage)
  }

  unsubscribe (onMessage) {
    if (this.channel.hasSubscribers) {
      this.channel.unsubscribe(onMessage)
    }
  }
}

// based on: https://github.com/trentm/node-bunyan#levels
const logChannels = {};
[Level.Debug, Level.Info, Level.Warn, Level.Error]
  .forEach((channelName, index) => {
    logChannels[channelName] = new LogLevel(channelName, (index + 2) * 10)
  })

const debugChannel = logChannels[Level.Debug]
const infoChannel = logChannels[Level.Info]
const warnChannel = logChannels[Level.Warn]
const errorChannel = logChannels[Level.Error]

function getChannelLogLevel (logLevel) {
  let logChannel
  if (logLevel && typeof logLevel === 'string') {
    logChannel = logChannels[logLevel.toLowerCase().trim()] || logChannels[_defaultLevel]
  } else {
    logChannel = logChannels[_defaultLevel]
  }
  return logChannel.logLevel
}

function subscribe (listeners) {
  for (const channelName in listeners) {
    const channel = logChannels[channelName]
    channel && channel.subscribe(listeners[channelName])
  }
}

function unsubscribe (listeners) {
  for (const channelName in listeners) {
    const channel = logChannels[channelName]
    channel && channel.unsubscribe(listeners[channelName])
  }
}

module.exports = {
  Level,
  getChannelLogLevel,
  subscribe,
  unsubscribe,

  debugChannel,
  infoChannel,
  warnChannel,
  errorChannel
}
