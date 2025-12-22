'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

// Symbol to mark queries that have been processed to avoid re-instrumentation
const DD_QUERY_PROCESSED = Symbol('dd-query-processed')

// WeakMap to store connection options keyed by handler function
const handlerOptionsMap = new WeakMap()

class PostgresClientPlugin extends DatabasePlugin {
  static id = 'postgres'
  static system = 'postgres'
  static prefix = 'tracing:orchestrion:postgres:Query_handle'

  bindStart (ctx) {
    const query = ctx.self

    // Check if this query has already been processed to avoid duplicate spans
    if (query && query[DD_QUERY_PROCESSED]) {
      return ctx.currentStore
    }

    if (query) {
      query[DD_QUERY_PROCESSED] = true
    }

    const queryText = getQueryText(query)
    const service = this.serviceName({ pluginConfig: this.config })

    const connOptions = getConnectionOptions(query)

    const span = this.startSpan(this.operationName(), {
      service,
      resource: queryText,
      type: 'sql',
      kind: 'client',
      meta: {
        component: 'postgres',
        'db.type': 'postgres',
        'db.name': connOptions.database,
        'db.user': connOptions.user,
        'out.host': connOptions.host,
        [CLIENT_PORT_KEY]: connOptions.port
      }
    }, ctx)

    injectDbmStringQuery(this, span, query, queryText, service)

    return ctx.currentStore
  }

  /**
   * Store connection options for a sql instance's handler.
   * This is called externally when connection options are available.
   */
  static storeConnectionOptions (handler, options) {
    if (handler && options) {
      const connOptions = {
        host: Array.isArray(options.host) ? options.host[0] : options.host,
        port: Array.isArray(options.port) ? options.port[0] : options.port,
        database: options.database,
        user: options.user || options.username
      }
      handlerOptionsMap.set(handler, connOptions)
    }
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (span) {
      if (ctx.error) {
        this.addError(ctx.error, span)
      }
      span.finish()
    }
  }
}

function injectDbmStringQuery (plugin, span, query, queryText, service) {
  if (plugin.config.dbmPropagationMode !== 'disabled' && query && query.strings) {
    const injectedQuery = plugin.injectDbmQuery(span, queryText, service)
    if (injectedQuery !== queryText) {
      // Replace the first string in the strings array with the modified query
      // The postgres library uses tagged template literals where strings is an array
      query.strings = [injectedQuery]
      query.args = []
    }
  }
}

function getQueryText (query) {
  if (!query || !query.strings) {
    return ''
  }

  // Handle tagged template literals
  // strings: ['SELECT * FROM ', ' WHERE id = ', ''], args: [table, id]
  // becomes: 'SELECT * FROM $1 WHERE id = $2'
  if (query.args && query.args.length > 0) {
    let result = ''
    for (let i = 0; i < query.strings.length; i++) {
      result += query.strings[i]
      if (i < query.args.length) {
        result += `$${i + 1}`
      }
    }
    return result
  }

  return query.strings[0] || ''
}

function getConnectionOptions (query) {
  // Try to get options from the handler
  // The handler is the function that was passed to Query constructor
  if (query && query.handler) {
    const options = handlerOptionsMap.get(query.handler)
    if (options) {
      return options
    }
  }

  // Default fallback values - connection info is not directly accessible
  // from the Query object in the postgres library
  return {
    host: undefined,
    port: undefined,
    database: undefined,
    user: undefined
  }
}

module.exports = PostgresClientPlugin
