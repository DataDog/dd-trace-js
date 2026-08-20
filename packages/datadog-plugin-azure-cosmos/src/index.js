'use strict'

const { createIntegrationPlugin } = require('../../dd-trace/src/plugins/integration-pipeline')
const { exitCodeOrigin } = require('../../dd-trace/src/plugins/stages/code-origin')
const { createPeerServiceStage } = require('../../dd-trace/src/plugins/stages/peer-service')

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
 * @typedef {object} CosmosSpanData
 * @property {CosmosRequestContext} requestContext
 * @property {string} [pluginOn]
 * @property {string} resource
 * @property {Record<string, string | undefined>} tags
 */

/**
 * Replace identifiers in a Cosmos resource path while retaining database and container names.
 *
 * @param {CosmosRequestContext} requestContext
 * @returns {string}
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
 * @param {CosmosRequestContext} requestContext
 * @returns {{dbName: string | undefined, containerName: string | undefined}}
 */
function getDbInfo (requestContext) {
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
 * Extract all Cosmos request fields needed to build the span.
 *
 * @param {import('../../dd-trace/src/plugins/integration-pipeline').InvocationContext} invocation
 * @returns {CosmosSpanData}
 */
function getSpanData (invocation) {
  const requestContext = invocation.arguments[1]
  const { dbName, containerName } = getDbInfo(requestContext)
  const connectionMode = requestContext.client?.connectionPolicy?.connectionMode === 0 ? 'gateway' : 'direct'

  return {
    requestContext,
    pluginOn: invocation.arguments[3],
    resource: getResource(requestContext),
    tags: {
      component: 'azure_cosmos',
      'db.system': 'cosmosdb',
      'db.name': dbName,
      'cosmosdb.container': containerName,
      'cosmosdb.connection.mode': connectionMode,
      'http.useragent': requestContext.headers?.['User-Agent'],
      'out.host': requestContext.client?.cosmosClientOptions?.endpoint,
    },
  }
}

/**
 * Decide whether an SDK request is already represented by its enclosing operation span.
 *
 * @param {import('../../dd-trace/src/plugins/integration-pipeline').PipelineFrame} frame
 * @returns {boolean}
 */
function isDuplicateRequest (frame) {
  const { pluginOn, requestContext } = frame.data
  if (pluginOn == null || requestContext.operationType == null || requestContext.resourceType == null) return false

  return pluginOn === 'request' && ((requestContext.operationType !== 'read' &&
    requestContext.operationType !== 'query') ||
    (requestContext.operationType === 'read' && requestContext.resourceType !== 'docs'))
}

/**
 * Empty-path account reads should suppress their nested HTTP client span as well.
 *
 * @param {import('../../dd-trace/src/plugins/integration-pipeline').PipelineFrame} frame
 * @returns {boolean}
 */
function isEmptyPathRead (frame) {
  const { requestContext } = frame.data
  return requestContext.operationType === 'read' && requestContext.path === ''
}

/**
 * Build completion tags from either the Cosmos response or error.
 *
 * @param {import('../../dd-trace/src/plugins/integration-pipeline').PipelineFrame} frame
 * @returns {Record<string, string | number | undefined> | undefined}
 */
function getResultTags (frame) {
  const response = frame.invocation.result || frame.invocation.error
  if (!response || typeof response !== 'object') return
  const code = Reflect.get(response, 'code')
  const substatus = Reflect.get(response, 'substatus')
  const hasSubstatus = typeof substatus === 'string' || typeof substatus === 'number'
  if (!code && !hasSubstatus) return

  return {
    'db.response.status_code': code ? String(code) : undefined,
    'cosmosdb.response.sub_status_code': hasSubstatus ? substatus : undefined,
  }
}

/**
 * Resolve the Azure Cosmos service through the storage-client naming schema.
 *
 * @param {import('../../dd-trace/src/plugins/integration-pipeline').PipelineFrame} frame
 * @returns {{name: string, source?: string}}
 */
function getService (frame) {
  return frame.serviceName({ type: 'storage', kind: 'client' })
}

module.exports = createIntegrationPlugin({
  id: 'azure-cosmos',
  operations: [{
    target: { module: '@azure/cosmos', name: 'executePlugins' },
    lifecycle: 'async',
    extract: { start: getSpanData },
    when: frame => !isDuplicateRequest(frame) && !isEmptyPathRead(frame),
    skip: frame => isEmptyPathRead(frame) ? 'noop' : 'parent',
    span: {
      name: 'cosmosdb.query',
      service: getService,
      resource: frame => frame.data.resource,
      type: 'cosmosdb',
      kind: 'client',
      tags: frame => frame.data.tags,
      resultTags: getResultTags,
    },
    stages: [
      exitCodeOrigin,
      createPeerServiceStage({ precursors: ['db.name'] }),
    ],
  }],
})
