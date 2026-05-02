'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const CachePlugin = require('../../dd-trace/src/plugins/cache')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')

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

/**
 * @param {string} command Uppercase command verb (e.g. `'GET'`).
 * @param {ArrayLike<unknown> | undefined} args Args array; may include the verb at index 0 when
 *   `argsStartIndex` is `1`.
 * @param {number} [argsStartIndex] Index in `args` to start formatting from. Defaults to `0`.
 * @returns {string}
 */
function formatCommand (command, args, argsStartIndex = 0) {
  if (!args || command === 'AUTH') return command

  let result = command
  for (let i = argsStartIndex, l = args.length; i < l; i++) {
    const arg = args[i]
    if (typeof arg === 'function') continue

    result = `${result} ${formatArg(arg)}`
    if (result.length > 1000) return trim(result, 1000)
  }

  return result
}

/**
 * @param {unknown} arg
 * @returns {string}
 */
function formatArg (arg) {
  if (typeof arg === 'string') {
    return arg.length > 100 ? arg.slice(0, 97) + '...' : arg
  }
  if (typeof arg === 'number') {
    return trim(String(arg), 100)
  }
  return '?'
}

function trim (str, maxlen) {
  if (str.length > maxlen) {
    str = str.slice(0, maxlen - 3) + '...'
  }

  return str
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
module.exports.formatCommand = formatCommand
