'use strict'

const RedisPlugin = require('../../datadog-plugin-redis/src')

class IORedisPlugin extends RedisPlugin {
  static id = 'ioredis'

  constructor (...args) {
    super(...args)
    // ioredis >= 5.11.0 emits built-in TracingChannel events on Node.js >= 19.9 / 20.2.
    // Subscribe directly so no shimmer is needed for those version combinations.
    this.addBind('tracing:ioredis:command:start', ctx => this.#bindBuiltinStart(ctx))
    // Use asyncEnd (not end) because tracePromise fires end before error.
    this.addSub('tracing:ioredis:command:asyncEnd', ctx => this.finish(ctx))
    this.addSub('tracing:ioredis:command:error', ctx => this.error(ctx))
  }

  /**
   * Normalizes the ioredis built-in TracingChannel context to the format
   * expected by RedisPlugin.bindStart.
   *
   * Built-in context: { command, args (sanitized, no command name), database, serverAddress, serverPort }
   *
   * @param {{ command: string, args: string[], database: number, serverAddress: string, serverPort: number | undefined }} builtinCtx
   * @returns {object}
   */
  #bindBuiltinStart (builtinCtx) {
    const ctx = {
      db: builtinCtx.database,
      command: builtinCtx.command,
      args: builtinCtx.args,
      connectionOptions: {
        host: builtinCtx.serverAddress,
        port: builtinCtx.serverPort,
      },
    }
    return this.bindStart(ctx)
  }
}

module.exports = IORedisPlugin
