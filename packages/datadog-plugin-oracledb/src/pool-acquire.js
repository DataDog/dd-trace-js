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

  /** @type {boolean} */
  #isServiceDynamic = false
  /**
   * @type {{
   *   nomenclatureConfig: object,
   *   operationName: string,
   *   service: { name: string, source: string | undefined }
   * } | undefined}
   */
  #naming

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
    let operationName
    let service
    if (this.#isServiceDynamic) {
      operationName = this.operationName({ operation: this.operation })
      service = this.serviceName({ pluginConfig: this.config, params: poolAttrs })
    } else {
      const nomenclatureConfig = this._tracer._nomenclature.config
      let naming = this.#naming
      if (naming?.nomenclatureConfig !== nomenclatureConfig) {
        naming = {
          nomenclatureConfig,
          operationName: this.operationName({ operation: this.operation }),
          service: this.serviceName({ pluginConfig: this.config }),
        }
        this.#naming = naming
      }
      operationName = naming.operationName
      service = naming.service
    }

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

  /**
   * @param {boolean | Record<string, unknown>} config
   */
  configure (config) {
    const result = super.configure(config)
    this.#isServiceDynamic = typeof this.config.service === 'function'
    this.#naming = undefined
    return result
  }
}

module.exports = OracledbPoolAcquirePlugin
