'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const CachePlugin = require('../../dd-trace/src/plugins/cache')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')

const MAX_ARG_LENGTH = 100
const MAX_COMMAND_LENGTH = 1000

class RedisPlugin extends CachePlugin {
  static id = 'redis'
  static system = 'redis'

  /** @type {string} */
  #rawCommandKey
  /** @type {Map<string | undefined, { name: string, source: string | undefined }>} */
  #serviceByConnection = new Map()
  // `nomenclature.config` identity at last cache fill. `withNamingSchema` swaps it without
  // running this plugin's `configure`, so identity drives invalidation in `bindStart`.
  /** @type {object | undefined} */
  #lastNomenclatureConfig
  /** @type {string | undefined} */
  #cachedOperationName

  constructor (...args) {
    super(...args)
    this._spanType = 'redis'
    // @redis/client >= 5.12.0 emits built-in TracingChannel events on Node.js >= 19.9 / 20.2.
    // Subscribe directly so no shimmer is needed for those version combinations.
    this.addBind('tracing:node-redis:command:start', ctx => this.#bindBuiltinRedisStart(ctx))
    // Use asyncEnd (not end) because tracePromise fires end before error.
    this.addSub('tracing:node-redis:command:asyncEnd', ctx => this.finish(ctx))
    this.addSub('tracing:node-redis:command:error', ctx => this.error(ctx))
  }

  /**
   * Normalizes the `@redis/client` built-in TracingChannel context to the format
   * expected by RedisPlugin.bindStart.
   *
   * Built-in context: { command (uppercase), args (includes command name at [0]),
   *   database, clientId, serverAddress, serverPort }
   *
   * @param {{ command: string, args: string[], database: number,
   *   serverAddress: string, serverPort: number | undefined }} builtinCtx
   * @returns {object}
   */
  #bindBuiltinRedisStart (builtinCtx) {
    const ctx = {
      db: builtinCtx.database,
      command: builtinCtx.command,
      args: builtinCtx.args,
      argsStartIndex: 1, // args[0] is the command name; skip it in formatting
      connectionOptions: {
        host: builtinCtx.serverAddress,
        port: builtinCtx.serverPort,
      },
    }
    return this.bindStart(ctx)
  }

  bindStart (ctx) {
    const { db, command, args, argsStartIndex, connectionOptions, connectionName } = ctx

    const resource = command
    const normalizedCommand = command.toUpperCase()
    if (!this.config.filter(normalizedCommand)) {
      return { noop: true }
    }

    const nomConfig = this._tracer._nomenclature.config
    if (this.#lastNomenclatureConfig !== nomConfig) {
      this.#lastNomenclatureConfig = nomConfig
      this.#cachedOperationName = undefined
      this.#serviceByConnection.clear()
    }

    let service = this.#serviceByConnection.get(connectionName)
    if (service === undefined) {
      service = this.serviceName({ pluginConfig: this.config, system: this.system, connectionName })
      this.#serviceByConnection.set(connectionName, service)
    }

    this.startSpan({
      resource,
      service,
      type: this._spanType,
      meta: {
        'db.type': this._spanType,
        'db.name': db || '0',
        [this.#rawCommandKey]: formatCommand(normalizedCommand, args, argsStartIndex),
        'out.host': connectionOptions.host,
        [CLIENT_PORT_KEY]: connectionOptions.port,
      },
    }, ctx)

    return ctx.currentStore
  }

  operationName () {
    this.#cachedOperationName ??= super.operationName()
    return this.#cachedOperationName
  }

  configure (config) {
    super.configure(normalizeConfig(config))
    // Subclasses (iovalkey) overwrite `_spanType` in their constructor, before any `configure`,
    // so reading it here is stable.
    this.#rawCommandKey = `${this._spanType}.raw_command`
    this.#lastNomenclatureConfig = undefined
    this.#cachedOperationName = undefined
    this.#serviceByConnection.clear()
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
