'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const StoragePlugin = require('../../dd-trace/src/plugins/storage')

let parser

class OracledbPoolAcquirePlugin extends StoragePlugin {
  static id = 'oracledb'
  static operation = 'pool.acquire'
  static prefix = 'apm:oracledb:pool:acquire'
  static system = 'oracle'
  static peerServicePrecursors = ['db.instance', 'db.hostname']

  /** @type {WeakMap<object, { dbInstance?: string, hostname?: string, port?: string }>} */
  #poolMetadata = new WeakMap()

  /**
   * @param {{
   *   connectionAttrs: { connectString?: string },
   *   pool: object,
   *   poolAttrs: object,
   *   user?: string
   * }} ctx
   */
  bindStart (ctx) {
    const { connectionAttrs, pool, poolAttrs, user } = ctx
    let metadata = this.#poolMetadata.get(pool)
    if (metadata === undefined) {
      parser ??= require('./connection-parser')
      metadata = parser(connectionAttrs)
      this.#poolMetadata.set(pool, metadata)
    }

    const { hostname, port, dbInstance } = metadata
    const operationName = this.operationName({ operation: this.operation })
    const service = this.serviceName({ pluginConfig: this.config, params: poolAttrs })

    this.startSpan(operationName, {
      service,
      resource: operationName,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.user': user,
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
