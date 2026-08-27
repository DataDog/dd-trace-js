'use strict'

const { storage } = require('../../datadog-core')
const { CLIENT_PORT_KEY, SVC_SRC_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const {
  configServiceName,
  optionServiceSource,
  storageServiceSource,
} = require('../../dd-trace/src/service-naming/helpers')

/** @typedef {import('../../dd-trace/src/plugins/tracing').NamingOptions} NamingOptions */

/**
 * @param {NamingOptions} options
 * @returns {string}
 */
function operationNameV0 ({ operation = 'query' } = {}) {
  return `pg.${operation}`
}

/**
 * @param {NamingOptions} options
 * @returns {string}
 */
function operationNameV1 ({ operation = 'query' } = {}) {
  return `postgresql.${operation}`
}

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string}
 */
function serviceNameV0 (tracerService, { params, pluginConfig } = {}) {
  return configServiceName(pluginConfig, params, `${tracerService}-postgres`)
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
    operationName: operationNameV0,
    serviceName: serviceNameV0,
    serviceSource: storageServiceSource('pg'),
  },
  v1: {
    operationName: operationNameV1,
    serviceName: serviceNameV1,
    serviceSource: optionServiceSource,
  },
}

class PGPlugin extends DatabasePlugin {
  static id = 'pg'
  static operation = 'query'
  static system = 'postgres'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  constructor () {
    super(...arguments)

    this.addSub('apm:pg:pool:connect:start', ctx => {
      ctx.parentStore = storage('legacy').getStore()
    })
    this.addBind('apm:pg:pool:connect:finish', ctx => ctx.parentStore)

    this.addSub('apm:pg:pool:acquire:start', ctx => {
      const params = ctx.poolOptions
      const operationName = this.operationName({ operation: 'pool.acquire' })
      const deferServiceResolution = typeof this.config.service === 'function'
      const service = deferServiceResolution
        ? undefined
        : this.serviceName({ pluginConfig: this.config, params })
      ctx.deferServiceResolution = deferServiceResolution

      this.startSpan(operationName, {
        service,
        resource: operationName,
        startTime: ctx.startTime,
        type: 'sql',
        kind: 'client',
        meta: {
          'db.type': 'postgres',
          ...connectionMeta(params),
        },
      }, ctx)
    })
    this.addSub('apm:pg:pool:acquire:finish', ctx => {
      const span = ctx.currentStore?.span
      if (span === undefined) return

      if (ctx.error) {
        this.addError(ctx.error, span)
      }
      span.setTag('db.pool.wait_time_ms', ctx.poolWaitTime)
      // `Pool` options carry only what the caller passed, so anything pg resolves later - a
      // connection string, the default port, `PG*` environment variables - is known once the
      // client exists.
      if (ctx.params !== undefined) {
        span.addTags(connectionMeta(ctx.params))
        if (ctx.deferServiceResolution) {
          const service = this.serviceName({ pluginConfig: this.config, params: ctx.params })
          // A `service` callback may return no name, and the start-time fallback already carries
          // the schema default every other pg span falls back to.
          if (service.name) {
            this.setServiceName(span, service.name)
            span.setTag(SVC_SRC_KEY, service.source)
          }
        }
      }
      this.finish(ctx)
    })
  }

  bindStart (ctx) {
    const { params = {}, query, originalText, processId, stream } = ctx
    const service = this.serviceName({ pluginConfig: this.config, params })
    const originalStatement = this.maybeTruncate(originalText)

    const span = this.startSpan(this.operationName(), {
      service,
      resource: originalStatement,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'postgres',
        'db.pid': processId,
        'db.name': params.database,
        'db.user': params.user,
        'out.host': params.host,
        [CLIENT_PORT_KEY]: params.port,
      },
    }, ctx)

    if (stream) {
      span.setTag('db.stream', 1)
    }

    if (ctx.poolWaitTime !== undefined) {
      span.setTag('db.pool.wait_time_ms', ctx.poolWaitTime)
    }

    ctx.injected = this.injectDbmQuery(span, originalText, service.name, !!query.name)

    return ctx.currentStore
  }
}

/**
 * `Pool.options` and `Client.connectionParameters` are pg internals, so either can be missing.
 *
 * @param {{ database?: string, user?: string, host?: string, port?: number } | undefined} params
 */
function connectionMeta (params) {
  return {
    'db.name': params?.database,
    'db.user': params?.user,
    'out.host': params?.host,
    [CLIENT_PORT_KEY]: params?.port,
  }
}

module.exports = PGPlugin
