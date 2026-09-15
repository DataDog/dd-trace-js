'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const StoragePlugin = require('../../dd-trace/src/plugins/storage')

let parser
const poolMetadata = new WeakMap()

class OracledbPoolAcquirePlugin extends StoragePlugin {
  static id = 'oracledb'
  static operation = 'pool.acquire'
  static prefix = 'apm:oracledb:pool:acquire'
  static system = 'oracle'
  static peerServicePrecursors = ['db.instance', 'db.hostname']

  /**
   * @param {{
   *   connectionAttrs: { connectString?: string, user?: string },
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
    const operationName = this.operationName({ operation: this.operation })
    const service = this.serviceName({ pluginConfig: this.config, params: poolAttrs })

    this.startSpan(operationName, {
      service,
      resource: operationName,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.user': connectionAttrs.user,
        'db.instance': dbInstance,
        'db.name': dbInstance,
        'db.hostname': hostname,
        'out.host': hostname,
        [CLIENT_PORT_KEY]: port,
      },
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = OracledbPoolAcquirePlugin
