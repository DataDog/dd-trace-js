'use strict'

const { storage } = require('../../datadog-core')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const NamingCache = require('./naming-cache')

let parser

/**
 * @param {{ poolAttrs: object }} ctx
 */
function bindPoolAttributes (ctx) {
  ctx.parentStore = storage('legacy').getStore()
  return {
    ...ctx.parentStore,
    oracledbPoolAttrs: ctx.poolAttrs,
  }
}

/**
 * @param {{ parentStore?: object }} ctx
 */
function bindPoolParent (ctx) {
  return ctx.parentStore
}

class OracledbQueryPlugin extends DatabasePlugin {
  static id = 'oracledb'
  static system = 'oracle'
  static peerServicePrecursors = ['db.instance', 'db.hostname']

  #naming = new NamingCache(this)

  constructor (...args) {
    super(...args)
    this.addBind('apm:oracledb:pool:session:start', bindPoolAttributes)
    this.addBind('apm:oracledb:pool:session:finish', bindPoolParent)
  }

  bindStart (ctx) {
    let { query, connAttrs, port, hostname, dbInstance } = ctx

    if (connAttrs === undefined) {
      connAttrs = storage('legacy').getStore()?.oracledbPoolAttrs
    }

    const { operationName, service } = this.#naming.get(connAttrs)

    if (hostname === undefined) {
      // Lazy load for performance. This is not needed in v6 and up
      parser ??= require('./connection-parser')
      const dbInfo = parser(connAttrs)
      hostname = dbInfo.hostname
      port ??= dbInfo.port
      dbInstance ??= dbInfo.dbInstance
    }

    // oracledb >= 6.4 accepts `execute({ statement, values })` (sql-template-tag form)
    // in addition to a plain SQL string. Extract the SQL text either way so we can tag
    // the resource and inject DBM into the statement, then re-wrap if needed to keep
    // the caller's binds.
    const sql = query?.statement ?? query

    const span = this.startSpan(operationName, {
      service,
      resource: sql,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.user': this.config.user,
        'db.instance': dbInstance,
        'db.name': dbInstance,
        'db.hostname': hostname,
        'out.host': hostname,
        [CLIENT_PORT_KEY]: port,
      },
    }, ctx)

    const injected = this.injectDbmQuery(span, sql, service.name)
    ctx.injected = query?.statement ? { ...query, statement: injected } : injected

    return ctx.currentStore
  }

  /**
   * @override
   * @param {boolean | Record<string, unknown>} config
   */
  configure (config) {
    const result = super.configure(config)
    this.#naming.configure()
    return result
  }
}

module.exports = OracledbQueryPlugin
