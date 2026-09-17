'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const StoragePlugin = require('../../dd-trace/src/plugins/storage')
const NamingCache = require('./naming-cache')

let parser
const poolMetadata = new WeakMap()

class OracledbPoolAcquirePlugin extends StoragePlugin {
  static id = 'oracledb'
  static operation = 'pool.acquire'
  static prefix = 'apm:oracledb:pool:acquire'
  static system = 'oracle'
  static peerServicePrecursors = ['db.instance', 'db.hostname']

  #naming = new NamingCache(this, this.operation)

  /**
   * @param {{
   *   connectionAttrs: { connectString?: string, homogeneous: boolean, user?: string },
   *   pool: object,
   *   poolAttrs: object
   * }} ctx
   */
  bindStart (ctx) {
    const { connectionAttrs, pool, poolAttrs } = ctx
    let dbInfo = poolMetadata.get(pool)
    if (dbInfo === undefined) {
      parser ??= require('./connection-parser')
      dbInfo = parser(connectionAttrs)
      poolMetadata.set(pool, dbInfo)
    }
    const { hostname, port, dbInstance } = dbInfo
    const { operationName, service } = this.#naming.get(poolAttrs)

    this.startSpan(operationName, {
      service,
      resource: operationName,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.user': connectionAttrs.homogeneous ? connectionAttrs.user : undefined,
        'db.instance': dbInstance,
        'db.name': dbInstance,
        'db.hostname': hostname,
        'out.host': hostname,
        [CLIENT_PORT_KEY]: port,
      },
    }, ctx)

    return ctx.currentStore
  }

  /**
   * @param {{
   *   currentStore?: { span: import('../../dd-trace').Span },
   *   user?: string
   * }} ctx
   */
  finish (ctx) {
    if (ctx.user !== undefined) {
      ctx.currentStore?.span.setTag('db.user', ctx.user)
    }
    super.finish(ctx)
  }

  /**
   * @param {boolean | Record<string, unknown>} config
   */
  configure (config) {
    const result = super.configure(config)
    this.#naming.configure()
    return result
  }
}

module.exports = OracledbPoolAcquirePlugin
