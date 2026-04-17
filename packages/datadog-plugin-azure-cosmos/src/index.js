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

  operationName() {
    return 'cosmosdb.query'
  }

  asyncEnd(ctx) {
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

  error(ctx) {
    const span = ctx.currentStore?.span
    this.addError(ctx.error, span)
    if (span != null) {
      const error = ctx.error
      if (error != null) {
        if (error.code != null) {
          span.setTag('http.status_code', error.code)
        }
        if (error.substatus !== undefined) {
          span.setTag('http.status_subcode', error.substatus)
        }
      }
    }
  }

  bindStart(ctx) {
    const requestContext = ctx.arguments?.[1]
    const resource = this.getResource(requestContext)
    const { dbName, containerName } = this.getDbInfo(requestContext)
    const connectionMode = this.getConnectionMode(requestContext)
    const { outHost, userAgent } = this.getHttpInfo(requestContext)
    const pluginOn = ctx.arguments?.[3]

    // getting really specific here but otherwise we get doubled up read spans
    // for the most part, only trace operations not requests (pluginOn)
    // trace requests only if they are read or query operations not on docs
    if (pluginOn === 'request' && ((!resource.includes('read') && !resource.includes('query')) ||
      (resource.includes('read') && requestContext.resourceType !== 'docs'))) {
      ctx.currentStore = { ...storage('legacy').getStore() }
      return ctx.currentStore
    }

    // separately, skip tracing read requests without a path, these don't
    // respresent CRUD operations on a resource we care about
    if (requestContext.operationType == 'read' && requestContext.path === '') {
      ctx.currentStore = { ...storage('legacy').getStore() }
      return ctx.currentStore
    }


    this.startSpan(this.operationName(), {
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

    return ctx.currentStore
  }

  getResource(requestContext) {
    if (requestContext != null) {
      const operationType = requestContext.operationType
      const resourceLink = requestContext.path
      return operationType + ' ' + resourceLink
    }
    return null
  }

  getDbInfo(requestContext) {
    let dbName = null
    let containerName = null
    if (requestContext != null) {
      if (requestContext.operationType === 'create' && requestContext.resourceType === 'dbs' &&
        requestContext.body != null && requestContext.body.id != null) {
        dbName = requestContext.body.id
      }

      let resourceLink = requestContext.path
      if (resourceLink != null) {
        if (resourceLink.startsWith('/') && resourceLink.length > 1) {
          resourceLink = resourceLink.slice(1)
        }
        const parts = resourceLink.split('/')
        if (parts.length > 0 && parts[0].toLowerCase() === 'dbs' && parts.length >= 2) {
          dbName = parts[1]
          if (parts.length >= 4 && parts[2].toLowerCase() === 'colls' && parts[3].toLowerCase() !== '') {
            containerName = parts[3]
          }
        }
      }
    }

    return { dbName, containerName }
  }

  getConnectionMode(requestContext) {
    if (requestContext != null) {
      const mode = requestContext.client?.connectionPolicy?.connectionMode
      if (mode === 0) {
        return 'gateway'
      } else if (mode === 1) {
        return 'direct'
      }
      return 'other'
    }
    return null
  }

  getHttpInfo(requestContext) {
    let outHost = null
    let userAgent = null
    if (requestContext != null) {
      outHost = requestContext.client?.cosmosClientOptions?.endpoint
      const headers = requestContext.headers
      if (headers != null) {
        userAgent = headers['User-Agent']
      }
    }
    return { outHost, userAgent }
  }
}

module.exports = AzureCosmosPlugin
