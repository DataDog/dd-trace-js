'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const CachePlugin = require('../../dd-trace/src/plugins/cache')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')

const MAX_ARG_LENGTH = 100
const MAX_COMMAND_LENGTH = 1000

class RedisPlugin extends CachePlugin {
  static id = 'redis'
  static system = 'redis'

  constructor (...args) {
    super(...args)
    this._spanType = 'redis'
  }

  bindStart (ctx) {
    const { db, command, args, argsStartIndex, connectionOptions, connectionName } = ctx

    const resource = command
    const normalizedCommand = command.toUpperCase()
    if (!this.config.filter(normalizedCommand)) {
      return { noop: true }
    }

    this.startSpan({
      resource,
      service: this.serviceName({ pluginConfig: this.config, system: this.system, connectionName }),
      type: this._spanType,
      meta: {
        'db.type': this._spanType,
        'db.name': db || '0',
        [`${this._spanType}.raw_command`]: formatCommand(normalizedCommand, args, argsStartIndex),
        'out.host': connectionOptions.host,
        [CLIENT_PORT_KEY]: connectionOptions.port,
      },
    }, ctx)

    return ctx.currentStore
  }

  configure (config) {
    super.configure(normalizeConfig(config))
  }
}

function formatCommand (command, args, argsStartIndex = 0) {
  if (!args || command === 'AUTH') return command

  let result = command
  for (let i = argsStartIndex, l = args.length; i < l; i++) {
    const arg = args[i]
    if (typeof arg === 'function') continue

    result = `${result} ${formatArg(arg)}`
    if (result.length > MAX_COMMAND_LENGTH) return result.slice(0, MAX_COMMAND_LENGTH - 3) + '...'
  }

  return result
}

function formatArg (arg) {
  if (typeof arg === 'string') {
    return arg.length > MAX_ARG_LENGTH ? arg.slice(0, MAX_ARG_LENGTH - 3) + '...' : arg
  }
  // Number stringification is bounded (~23 chars max), so it never hits MAX_ARG_LENGTH.
  if (typeof arg === 'number') return String(arg)
  return '?'
}

function normalizeConfig (config) {
  if (config.allowlist) uppercaseAllEntries(config.allowlist)
  if (config.whitelist) uppercaseAllEntries(config.whitelist)
  if (config.blocklist) uppercaseAllEntries(config.blocklist)
  if (config.blacklist) uppercaseAllEntries(config.blacklist)

  const filter = urlFilter.getFilter(config)

  return { ...config, filter }
}

function uppercaseAllEntries (entries) {
  for (let i = 0; i < entries.length; i++) {
    entries[i] = String(entries[i]).toUpperCase()
  }
}

module.exports = RedisPlugin
