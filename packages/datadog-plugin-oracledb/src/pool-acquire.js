'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const StoragePlugin = require('../../dd-trace/src/plugins/storage')

let parser

/**
 * @typedef {{
 *   dbInfo: { dbInstance?: string, hostname?: string, port?: string },
 *   naming?: {
 *     config: object,
 *     nomenclatureConfig: object,
 *     operationName: string,
 *     service: { name: string, source: string | undefined }
 *   }
 * }} PoolMetadata
 */

class OracledbPoolAcquirePlugin extends StoragePlugin {
  static id = 'oracledb'
  static operation = 'pool.acquire'
  static prefix = 'apm:oracledb:pool:acquire'
  static system = 'oracle'
  static peerServicePrecursors = ['db.instance', 'db.hostname']

  /** @type {WeakMap<object, PoolMetadata>} */
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
      metadata = { dbInfo: parser(connectionAttrs) }
      this.#poolMetadata.set(pool, metadata)
    }

    const nomenclatureConfig = this._tracer._nomenclature.config
    if (metadata.naming?.config !== this.config || metadata.naming.nomenclatureConfig !== nomenclatureConfig) {
      metadata.naming = {
        config: this.config,
        nomenclatureConfig,
        operationName: this.operationName({ operation: this.operation }),
        service: this.serviceName({ pluginConfig: this.config, params: poolAttrs }),
      }
    }

    const { hostname, port, dbInstance } = metadata.dbInfo
    const { operationName, service } = metadata.naming

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
