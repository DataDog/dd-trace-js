'use strict'

/**
 * @typedef {object} CosmosRequestContext
 * @property {string} path
 * @property {string} [operationType]
 * @property {string} [resourceType]
 * @property {Record<string, unknown>} [body]
 * @property {Record<string, string>} [headers]
 * @property {{
 *   connectionPolicy?: {connectionMode?: number},
 *   cosmosClientOptions?: {endpoint?: string}
 * }} [client]
 */

/**
 * @typedef {object} CosmosInvocationContext
 * @property {[unknown, CosmosRequestContext, unknown, (string | undefined)]} arguments
 * @property {unknown} [result]
 * @property {unknown} [error]
 */

/**
 * Replace identifiers in a Cosmos resource path while retaining database and container names.
 *
 * @param {CosmosRequestContext} requestContext Cosmos request context.
 * @returns {string} Low-cardinality query resource.
 */
function getResource (requestContext) {
  const { path } = requestContext
  const parts = path.split('/')
  let modified = false
  for (let i = 2; i < parts.length; i += 2) {
    if (parts[i].length > 0 && parts[i - 1] !== 'dbs' && parts[i - 1] !== 'colls') {
      parts[i] = '?'
      modified = true
    }
  }

  return `${requestContext.operationType} ${modified ? parts.join('/') : path}`
}

/**
 * Extract database and container names from a Cosmos request.
 *
 * @param {CosmosRequestContext} requestContext Cosmos request context.
 * @returns {{dbName: string | undefined, containerName: string | undefined}} Database identity.
 */
function getDatabaseInfo (requestContext) {
  let dbName
  let containerName

  if (requestContext.operationType === 'create' && requestContext.resourceType === 'dbs' &&
    requestContext.body?.id != null) {
    dbName = String(requestContext.body.id)
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

  return { dbName, containerName }
}

/**
 * Decide whether an SDK request is already represented by its enclosing operation span.
 *
 * @param {CosmosRequestContext} requestContext Cosmos request context.
 * @param {string | undefined} pluginOn Cosmos plugin lifecycle level.
 * @returns {boolean} Whether to inherit the enclosing operation context.
 */
function isDuplicateRequest (requestContext, pluginOn) {
  if (pluginOn == null || requestContext.operationType == null || requestContext.resourceType == null) return false

  return pluginOn === 'request' && ((requestContext.operationType !== 'read' &&
    requestContext.operationType !== 'query') ||
    (requestContext.operationType === 'read' && requestContext.resourceType !== 'docs'))
}

module.exports = {
  targets: [{
    module: '@azure/cosmos',
    name: 'executePlugins',
    lifecycle: 'async',
  }],

  /**
   * Normalize one Cosmos query invocation into database facts.
   *
   * @param {CosmosInvocationContext} context Raw Orchestrion invocation context.
   * @returns {object} Shared database query facts or a skip decision.
   */
  start (context) {
    const requestContext = context.arguments[1]
    const pluginOn = context.arguments[3]
    if (isDuplicateRequest(requestContext, pluginOn)) return { skip: 'parent' }
    if (requestContext.operationType === 'read' && requestContext.path === '') return { skip: 'noop' }

    const { dbName, containerName } = getDatabaseInfo(requestContext)
    const connectionMode = requestContext.client?.connectionPolicy?.connectionMode === 0 ? 'gateway' : 'direct'

    return {
      connection: {
        database: dbName,
        host: requestContext.client?.cosmosClientOptions?.endpoint,
      },
      resource: getResource(requestContext),
      tags: {
        'cosmosdb.container': containerName,
        'cosmosdb.connection.mode': connectionMode,
        'http.useragent': requestContext.headers?.['User-Agent'],
      },
    }
  },

  /**
   * Normalize Cosmos response status fields on success or failure.
   *
   * @param {CosmosInvocationContext} context Raw Orchestrion invocation context.
   * @returns {Record<string, string | number | undefined> | undefined} Completion metadata.
   */
  complete (context) {
    const response = context.result || context.error
    if (!response || typeof response !== 'object') return

    const code = Reflect.get(response, 'code')
    const substatus = Reflect.get(response, 'substatus')
    const hasSubstatus = typeof substatus === 'string' || typeof substatus === 'number'
    if (!code && !hasSubstatus) return

    return {
      'db.response.status_code': code ? String(code) : undefined,
      'cosmosdb.response.sub_status_code': hasSubstatus ? substatus : undefined,
    }
  },
}
