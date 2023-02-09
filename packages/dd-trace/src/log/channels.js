'use strict'

const dc = require('diagnostics_channel')

const Level = {
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error'
}

const defaultLevel = Level.Debug

class LogChannel extends dc.Channel {
  constructor (name, logLevel) {
    super(`datadog:log:${name}`)
    this.logLevel = logLevel
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
    logChannel = logChannels[level.toLowerCase().trim()] || logChannels[defaultLevel]
  } else {
    logChannel = logChannels[defaultLevel]
  }
  return logChannel.logLevel
}

module.exports = {
  Level,
  getChannelLogLevel,

  debugChannel: logChannels[Level.Debug],
  infoChannel: logChannels[Level.Info],
  warnChannel: logChannels[Level.Warn],
  errorChannel: logChannels[Level.Error]
}
