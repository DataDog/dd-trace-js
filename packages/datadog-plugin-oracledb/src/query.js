'use strict'

const { storage } = require('../../datadog-core')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

let parser

/** @typedef {{ name: string, source: string | undefined }} Service */

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

  /** @type {boolean} */
  #dynamicService = false
  /** @type {object | undefined} */
  #nomenclatureConfig
  /** @type {string | undefined} */
  #operationName
  /** @type {object | string | undefined} */
  #params
  /** @type {Service | undefined} */
  #service
  /** @type {WeakMap<object, Service>} */
  #services = new WeakMap()

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

    if (this.#nomenclatureConfig !== this._tracer._nomenclature.config) {
      this.#refreshNaming()
    }
    const service = this.#getService(connAttrs)

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

    const span = this.startSpan(this.#operationName, {
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

  #refreshNaming () {
    this.#nomenclatureConfig = this._tracer._nomenclature.config
    this.#operationName = this.operationName()
    this.#params = undefined
    this.#service = undefined
    this.#services = new WeakMap()
  }

  /**
   * @param {object | string | undefined} params
   * @returns {Service}
   */
  #getService (params) {
    if (!this.#dynamicService) {
      this.#service ??= this.serviceName({ pluginConfig: this.config, params })
      return this.#service
    }

    if (typeof params === 'object' && params !== null) {
      let service = this.#services.get(params)
      if (service === undefined) {
        service = this.serviceName({ pluginConfig: this.config, params })
        this.#services.set(params, service)
      }
      return service
    }

    if (this.#service === undefined || this.#params !== params) {
      this.#params = params
      this.#service = this.serviceName({ pluginConfig: this.config, params })
    }
    return this.#service
  }

  /**
   * @override
   * @param {boolean | Record<string, unknown>} config
   */
  configure (config) {
    const result = super.configure(config)
    this.#dynamicService = typeof this.config.service === 'function'
    this.#nomenclatureConfig = undefined
    return result
  }
}

module.exports = OracledbQueryPlugin
