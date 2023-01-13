'use strict'

const dc = require('diagnostics_channel')

const Level = {
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error'
}

const _defaultLevel = Level.Debug

class LogChannel extends dc.Channel {
  constructor (name, logLevel) {
    super(`dd-trace:log:${name}`)
    this.logLevel = logLevel
  }

  publish (message) {
    if (this.hasSubscribers) {
      return this.publish(message)
    }
  }

  unsubscribe (onMessage) {
    if (this.hasSubscribers) {
      this.unsubscribe(onMessage)
    }
  }
}

// based on: https://github.com/trentm/node-bunyan#levels
const logChannels = {
  [Level.Debug]: new LogChannel(Level.Debug, 20),
  [Level.Info]: new LogChannel(Level.Info, 30),
  [Level.Warn]: new LogChannel(Level.Warn, 40),
  [Level.Error]: new LogChannel(Level.Error, 50)
}

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

  debugChannel: logChannels[Level.Debug],
  infoChannel: logChannels[Level.Info],
  warnChannel: logChannels[Level.Warn],
  errorChannel: logChannels[Level.Error]
}
