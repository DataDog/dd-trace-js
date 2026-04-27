'use strict'

const { storage } = require('../../datadog-core')

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class AzureCosmosPlugin extends DatabasePlugin {
  static id = 'azure-cosmos'
  // Channel prefix determines how the plugin subscribes to instrumentation events.
  // Three patterns exist — set `static prefix` explicitly based on instrumentation type:
  //
  // Orchestrion:              static prefix = 'tracing:orchestrion:<npm-package>:<channelName>'
  // Shimmer + tracingChannel: static prefix = 'tracing:apm:<name>:<operation>'
  // Shimmer + manual channels: omit prefix — defaults to `apm:${id}:${operation}`
  static prefix = 'tracing:orchestrion:@azure/cosmos:executePlugins'
  static peerServicePrecursors = ['db.name']

  operationName () {
    return 'cosmosdb.query'
  }

  asyncEnd (ctx) {
    if (!ctx.span) return
    const span = ctx.currentStore?.span
    if (span != null) {
      const result = ctx.result
      if (result != null) {
        if (result.code != null) {
          span.setTag('http.status_code', result.code)
        }
        if (result.substatus !== undefined) {
          span.setTag('http.status_subcode', result.substatus)
        }
      }
      span.finish()
    }
  }

  error (ctx) {
    if (!ctx.span) return
    const span = ctx.currentStore?.span
    if (span != null) {
      this.addError(ctx.error, span)
      const error = ctx.error
      if (error?.code != null) {
        span.setTag('http.status_code', error.code)
      }
      if (error?.substatus != null) {
        span.setTag('http.status_subcode', error.substatus)
      }
    }
  }

  bindStart (ctx) {
    const requestContext = ctx.arguments?.[1]
    const resource = this.getResource(requestContext)
    const { dbName, containerName } = this.getDbInfo(requestContext)
    const connectionMode = this.getConnectionMode(requestContext)
    const { outHost, userAgent } = this.getHttpInfo(requestContext)
    const pluginOn = ctx.arguments?.[3]

    // only trace operations not requests (pluginOn)
    // trace requests only if they are read or query operations not on docs
    // prevents doubled read spans for createIfNotExists calls
    if (pluginOn != null && requestContext.operationType != null && requestContext.resourceType != null) {
      const operationType = requestContext.operationType
      const resourceType = requestContext.resourceType
      if (pluginOn === 'request' && ((operationType !== 'read' && operationType !== 'query') ||
        (operationType === 'read' && resourceType !== 'docs'))) {
        ctx.currentStore = { ...storage('legacy').getStore() }
        return ctx.currentStore
      }

      // separately, skip tracing read requests without a path, these don't
      // represent CRUD operations on a resource we care about
      // not returning current store because we don't want the child http.request spans
      // to be created
      if (operationType === 'read' && requestContext.path === '') {
        return
      }
    }

    const span = this.startSpan(this.operationName(), {
      resource,
      type: 'cosmosdb',
      kind: 'client',
      meta: {
        component: 'azure_cosmos',
        'db.system': 'cosmosdb',
        'db.name': dbName,
        'cosmosdb.container': containerName,
        'cosmosdb.connection.mode': connectionMode,
        'http.useragent': userAgent,
        'out.host': outHost,
      },
    }, ctx)

    ctx.span = span
    return ctx.currentStore
  }

  getResource (requestContext) {
    return requestContext
      ? `${requestContext.operationType} ${requestContext.path}`
      : null
  }

  getDbInfo (requestContext) {
    let dbName = null
    let containerName = null
    if (requestContext != null) {
      if (requestContext.operationType === 'create' && requestContext.resourceType === 'dbs' &&
        requestContext.body != null && requestContext.body.id != null) {
        dbName = requestContext.body.id
      }

      let resourceLink = requestContext.path
      if (resourceLink?.length > 1 && resourceLink.startsWith('/')) {
        resourceLink = resourceLink.slice(1)
        const parts = resourceLink.split('/')
        if (parts.length > 0 && parts[0].toLowerCase() === 'dbs' && parts.length >= 2) {
          dbName = parts[1]
          if (parts.length >= 4 && parts[2].toLowerCase() === 'colls' && parts[3] !== '') {
            containerName = parts[3]
          }
        }
      }
    }

    return { dbName, containerName }
  }

  getConnectionMode (requestContext) {
    if (!requestContext) {
      return null
    }
    const mode = requestContext.client?.connectionPolicy?.connectionMode
    if (mode === 0) {
      return 'gateway'
    } else if (mode === 1) {
      return 'direct'
    }
    return 'other'
  }

  getHttpInfo (requestContext) {
    const outHost = requestContext?.client?.cosmosClientOptions?.endpoint
    const userAgent = requestContext?.headers?.['User-Agent']
    return { outHost, userAgent }
  }
}

module.exports = AzureCosmosPlugin
