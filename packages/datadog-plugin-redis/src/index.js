'use strict'

const CachePlugin = require('../../dd-trace/src/plugins/cache')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')

class RedisPlugin extends CachePlugin {
  static name = 'redis'
  static system = 'redis'

  start ({ db, command, args, connectionOptions = {}, connectionName }) {
    if (!this.config.filter(command)) return this.skip()

    this.startSpan('redis.command', {
      service: getService(this.config, connectionName),
      resource: command,
      type: 'redis',
      kind: 'client',
      meta: {
        'db.type': 'redis',
        'db.name': db || '0',
        'redis.raw_command': formatCommand(command, args),
        'out.host': connectionOptions.host,
        'out.port': connectionOptions.port
      }
    })
  }

  configure (config) {
    super.configure(normalizeConfig(config))
  }
}

function getService (config, connectionName) {
  if (config.splitByInstance && connectionName) {
    return config.service
      ? `${config.service}-${connectionName}`
      : connectionName
  }

  return config.service
}

function formatCommand (command, args) {
  command = command.toUpperCase()

  if (!args || command === 'AUTH') return command

  for (let i = 0, l = args.length; i < l; i++) {
    if (typeof args[i] === 'function') continue

    command = `${command} ${formatArg(args[i])}`

    if (command.length > 1000) return trim(command, 1000)
  }

  return command
}

function formatArg (arg) {
  switch (typeof arg) {
    case 'string':
    case 'number':
      return trim(String(arg), 100)
    default:
      return '?'
  }
}

function trim (str, maxlen) {
  if (str.length > maxlen) {
    str = str.substr(0, maxlen - 3) + '...'
  }

  return str
}

function normalizeConfig (config) {
  const filter = urlFilter.getFilter(config)

  return Object.assign({}, config, {
    filter
  })
}

module.exports = RedisPlugin
