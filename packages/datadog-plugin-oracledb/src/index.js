'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const {
  configServiceName,
  optionServiceSource,
  storageServiceSource,
} = require('../../dd-trace/src/service-naming/helpers')

let parser

/** @typedef {import('../../dd-trace/src/plugins/tracing').NamingOptions} NamingOptions */

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string}
 */
function serviceNameV0 (tracerService, { params, pluginConfig } = {}) {
  return configServiceName(pluginConfig, params, `${tracerService}-oracle`)
}

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string}
 */
function serviceNameV1 (tracerService, { params, pluginConfig } = {}) {
  return configServiceName(pluginConfig, params, tracerService)
}

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'oracle.query',
    serviceName: serviceNameV0,
    serviceSource: storageServiceSource('oracledb'),
  },
  v1: {
    operationName: () => 'oracle.query',
    serviceName: serviceNameV1,
    serviceSource: optionServiceSource,
  },
}

class OracledbPlugin extends DatabasePlugin {
  static id = 'oracledb'
  static system = 'oracle'
  static peerServicePrecursors = ['db.instance', 'db.hostname']

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  bindStart (ctx) {
    let { query, connAttrs, port, hostname, dbInstance } = ctx

    const service = this.serviceName({ pluginConfig: this.config, params: connAttrs })

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

    const span = this.startSpan(this.operationName(), {
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
}

module.exports = OracledbPlugin
