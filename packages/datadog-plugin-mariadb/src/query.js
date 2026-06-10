'use strict'

const { storage } = require('../../datadog-core')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

const DD_SPAN = Symbol('dd-mariadb-span')

// Stash caller's async-context store on the Command instance so completion
// channels can restore it inside the user callback. Needed because v2's
// _queryCallback is an arrow assigned to a this-property; orchestrion's
// arrow wrap misroutes (sql, cb) calls to the promise path, dropping
// :asyncStart. Binding at successEnd / throwError re-establishes context
// synchronously around the this.resolve / this.reject call.
const DD_PARENT_STORE = Symbol('dd-mariadb-parent-store')

// User-facing API channels that only need context propagation (no spans).
// A single plugin instance subscribes to all of them rather than one class
// per channel.
const USER_FACING_CHANNELS = [
  'ConnectionCallback_query',
  'ConnectionCallback_execute',
  'ConnectionPromise_query',
  'ConnectionPromise_execute',
  'PoolCallback_query',
  'PoolCallback_execute',
  'PoolPromise_query',
  'PoolPromise_execute',
  'v2Connection_queryPromise',
  'v2Connection_query',
  'v2Connection_queryCallback',
  'v2PoolBase_query',
  'PrepareResultPacket_execute',
]

// Subscribes to all user-facing query/execute channels and handles only
// context propagation — capturing parentStore at :start so that
// wrapCallback's asyncStart.runStores can restore it inside user callbacks.
// Span lifecycle is owned by the Command-level plugins below.
class MariadbQueryContextPlugin extends DatabasePlugin {
  static id = 'mariadb'
  static system = 'mariadb'
  static operation = 'query'

  constructor () {
    super(...arguments)
    for (const name of USER_FACING_CHANNELS) {
      const prefix = `tracing:orchestrion:mariadb:${name}`
      this.addBind(`${prefix}:start`, ctx => {
        ctx.parentStore = storage('legacy').getStore()
        return ctx.parentStore
      })
      this.addBind(`${prefix}:asyncStart`, ctx => ctx.parentStore)
    }
  }
}

class MariadbCommandPlugin extends DatabasePlugin {
  static id = 'mariadb'
  static system = 'mariadb'
  static operation = 'query'

  constructor () {
    super(...arguments)
    const prefix = this.constructor.prefix
    // Wire span creation to :end so ctx.self (the Command instance) is
    // populated — this.sql and this.opts are set by the time super() returns.
    this.addSub(`${prefix}:end`, ctx => this.startSpanFromCommand(ctx))
  }

  // Returns the connection config for span metadata.
  // V2QueryCommandPlugin overrides this because v2's configAssign strips
  // host/user/database/port from cmd.opts.
  getConf (ctx, cmd) {
    return cmd.opts || {}
  }

  startSpanFromCommand (ctx) {
    const cmd = ctx.self
    if (!cmd) return

    const conf = this.getConf(ctx, cmd)
    const sql = cmd.sql
    const service = this.serviceName({ pluginConfig: this.config, dbConfig: conf, system: this.system })

    const span = this.startSpan(this.operationName(), {
      service,
      resource: sql,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': this.system,
        'db.user': conf.user,
        'db.name': conf.database,
        'out.host': conf.host,
        [CLIENT_PORT_KEY]: conf.port,
      },
      childOf: this.activeSpan,
    }, ctx)

    cmd.sql = this.injectDbmQuery(span, sql, service.name)
    cmd[DD_SPAN] = span
    cmd[DD_PARENT_STORE] = storage('legacy').getStore()
  }
}

// Handles both Query and Execute constructors — same span logic, different channel.
class QueryCommandPlugin extends MariadbCommandPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:Query_construct'

  constructor () {
    super(...arguments)
    this.addSub('tracing:orchestrion:mariadb:Execute_construct:end', ctx => this.startSpanFromCommand(ctx))
  }
}

class V2QueryCommandPlugin extends MariadbCommandPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2Query_construct'

  // v2 configAssign strips host/user/database/port from this.opts;
  // the raw connOpts is passed as constructor argument index 3.
  getConf (ctx) {
    return ctx.arguments?.[3] || {}
  }
}

// Handles both Command.successEnd and Command.throwError in one plugin.
// addBind restores the caller's store (so user callbacks fire in the right
// async context); addSub finishes the span and tags errors.
class CommandCompletionPlugin extends DatabasePlugin {
  static id = 'mariadb'
  static system = 'mariadb'
  static operation = 'query'

  constructor () {
    super(...arguments)
    const SUCCESS = 'tracing:orchestrion:mariadb:Command_successEnd'
    const THROW = 'tracing:orchestrion:mariadb:Command_throwError'
    this.addBind(`${SUCCESS}:start`, ctx => ctx.self?.[DD_PARENT_STORE])
    this.addSub(`${SUCCESS}:start`, ctx => this.finishSpan(ctx, false))
    this.addBind(`${THROW}:start`, ctx => ctx.self?.[DD_PARENT_STORE])
    this.addSub(`${THROW}:start`, ctx => this.finishSpan(ctx, true))
  }

  finishSpan (ctx, isError) {
    const cmd = ctx.self
    if (!cmd) return
    const span = cmd[DD_SPAN]
    if (!span) return
    cmd[DD_SPAN] = undefined
    cmd[DD_PARENT_STORE] = undefined

    if (isError && ctx.arguments?.[0]) {
      this.addError(ctx.arguments[0], span)
    }

    this.tagPeerService(span)
    span.finish()
  }
}

module.exports = [
  MariadbQueryContextPlugin,
  QueryCommandPlugin,
  V2QueryCommandPlugin,
  CommandCompletionPlugin,
]
