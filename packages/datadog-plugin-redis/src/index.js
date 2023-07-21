'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const CachePlugin = require('../../dd-trace/src/plugins/cache')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')

class RedisPlugin extends CachePlugin {
  static get id () { return 'redis' }
  static get system () { return 'redis' }

  start ({ db, command, args, connectionOptions = {}, connectionName }) {
    const resource = command
    const normalizedCommand = command.toUpperCase()
    if (!this.config.filter(normalizedCommand)) return this.skip()

    this.startSpan({
      resource,
      service: this.serviceName({ pluginConfig: this.config, system: this.system, connectionName }),
      type: 'redis',
      meta: {
        'db.type': 'redis',
        'db.name': db || '0',
        'redis.raw_command': formatCommand(normalizedCommand, args),
        'out.host': connectionOptions.host,
        [CLIENT_PORT_KEY]: connectionOptions.port
      }
    })
  }

  configure (config) {
    super.configure(normalizeConfig(config))
  }
}

function formatCommand (command, args) {
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
  if (config.allowlist) uppercaseAllEntries(config.allowlist)
  if (config.whitelist) uppercaseAllEntries(config.whitelist)
  if (config.blocklist) uppercaseAllEntries(config.blocklist)
  if (config.blacklist) uppercaseAllEntries(config.blacklist)

  const filter = urlFilter.getFilter(config)

  return Object.assign({}, config, {
    filter
  })
}

function uppercaseAllEntries (entries) {
  for (let i = 0; i < entries.length; i++) {
    entries[i] = String(entries[i]).toUpperCase()
  }
}

module.exports = RedisPlugin
