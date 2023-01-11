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
    this.channel = dc.channel(`dd-trace:log:${name}`)
    this.logLevel = logLevel
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
  .forEach((level, index) => {
    logChannels[level] = new LogLevel(level, (index + 2) * 10)
  })

const debugChannel = logChannels[Level.Debug]
const infoChannel = logChannels[Level.Info]
const warnChannel = logChannels[Level.Warn]
const errorChannel = logChannels[Level.Error]

function getChannelLogLevel (level) {
  let logChannel
  if (level && typeof level === 'string') {
    logChannel = logChannels[level.toLowerCase().trim()] || logChannels[_defaultLevel]
  } else {
    logChannel = logChannels[_defaultLevel]
  }
  return logChannel.logLevel
}

function subscribe (listeners) {
  for (const level in listeners) {
    const logChannel = logChannels[level]
    logChannel && logChannel.subscribe(listeners[level])
  }
}

function unsubscribe (listeners) {
  for (const level in listeners) {
    const logChannel = logChannels[level]
    logChannel && logChannel.unsubscribe(listeners[level])
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
