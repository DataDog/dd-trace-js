'use strict'

const { channel } = require('dc-polyfill')

const Level = {
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error'
}

const defaultLevel = Level.Debug

// based on: https://github.com/trentm/node-bunyan#levels
const logChannels = {
  [Level.Debug]: createLogChannel(Level.Debug, 20),
  [Level.Info]: createLogChannel(Level.Info, 30),
  [Level.Warn]: createLogChannel(Level.Warn, 40),
  [Level.Error]: createLogChannel(Level.Error, 50)
}

function createLogChannel (name, logLevel) {
  const logChannel = channel(`datadog:log:${name}`)
  logChannel.logLevel = logLevel
  return logChannel
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
