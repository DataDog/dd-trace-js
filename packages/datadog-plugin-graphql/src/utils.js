'use strict'

const { LRUCache } = require('../../../vendor/dist/lru-cache')

/**
 * @typedef {{ signature: string, type: import('graphql').OperationTypeNode, name?: string }} RequestOperation
 */

const requestCacheMax = 500

/**
 * @typedef {{
 *   document: WeakRef<import('graphql').DocumentNode>,
 *   operations: Map<string, RequestOperation>
 * }} DocumentOperations
 */

/**
 * @typedef {{
 *   documentOperations: WeakMap<object, DocumentOperations>,
 *   documents: import('lru-cache')<string, WeakRef<import('graphql').DocumentNode>>,
 *   operations: import('lru-cache')<string, RequestOperation>
 * }} RequestCache
 */

/** @type {WeakMap<object, RequestCache>} */
const requestCaches = new WeakMap()

/**
 * @param {object | undefined} owner
 * @param {boolean | number | undefined} configuredLimit
 * @returns {RequestCache | undefined}
 */
function getRequestCache (owner, configuredLimit) {
  if (!owner || configuredLimit === false || (typeof configuredLimit === 'number' && configuredLimit <= 0)) return

  let requestCache = requestCaches.get(owner)
  if (requestCache !== undefined) return requestCache

  const max = typeof configuredLimit === 'number'
    ? Math.min(Math.floor(configuredLimit), requestCacheMax)
    : requestCacheMax
  if (max <= 0) return

  requestCache = {
    documentOperations: new WeakMap(),
    documents: new LRUCache({ max }),
    operations: new LRUCache({ max }),
  }
  requestCaches.set(owner, requestCache)
  return requestCache
}

/**
 * @param {string | null | undefined} operationName
 * @param {boolean} calculateSignature
 * @returns {string}
 */
function operationCacheKey (operationName, calculateSignature) {
  return `${calculateSignature === false ? 0 : 1}\n${operationName ?? ''}`
}

/**
 * @param {unknown} source
 * @param {string | null | undefined} operationName
 * @param {boolean} calculateSignature
 * @param {RequestCache | undefined} requestCache
 * @returns {RequestOperation | undefined}
 */
function getCachedRequestOperation (source, operationName, calculateSignature, requestCache) {
  if (requestCache === undefined) return

  const operationKey = operationCacheKey(operationName, calculateSignature)
  if (typeof source === 'string') {
    // GraphQL operation names cannot contain newlines, so source text cannot collide with this prefix.
    const key = `${operationKey}\n${source}`
    let operation = requestCache.operations.get(key)
    if (operation !== undefined) return operation

    const document = requestCache.documents.get(source)?.deref()
    if (document === undefined) return

    operation = getRequestOperation(document, operationName, calculateSignature)
    if (operation === undefined) return

    requestCache.operations.set(key, operation)
    return operation
  }
  if (source === null || typeof source !== 'object') return

  const cached = requestCache.documentOperations.get(source)
  if (cached === undefined) return

  let operation = cached.operations.get(operationKey)
  const document = cached.document.deref()
  if (operation !== undefined || document === undefined) return operation

  operation = getRequestOperation(document, operationName, calculateSignature)
  if (operation === undefined) return

  cached.operations.set(operationKey, operation)
  return operation
}

/**
 * @param {unknown} source
 * @returns {source is string | object}
 */
function isCacheableSource (source) {
  return typeof source === 'string' || (source !== null && typeof source === 'object')
}

/**
 * @param {import('graphql').DocumentNode | undefined} document
 * @param {string | null | undefined} operationName
 * @returns {import('graphql').OperationDefinitionNode | undefined}
 */
function getOperation (document, operationName) {
  if (!document || !Array.isArray(document.definitions)) return

  let operation
  for (const definition of document.definitions) {
    if (definition.kind !== 'OperationDefinition') continue

    if (operationName != null) {
      if (definition.name?.value === operationName) return definition
      continue
    }

    if (operation !== undefined) return
    operation = definition
  }

  return operation
}

/**
 * @param {import('../../dd-trace/src/opentracing/span') | undefined} requestSpan
 * @param {string} signature
 * @param {import('graphql').OperationTypeNode | undefined} type
 * @param {string | undefined} name
 */
function refineRequestSpanMetadata (requestSpan, signature, type, name) {
  if (!requestSpan || requestSpan.ddRequestRefined) return
  requestSpan.ddRequestRefined = true

  if (signature) requestSpan.setTag('resource.name', signature)
  if (type) requestSpan.setTag('graphql.operation.type', type)
  if (name) requestSpan.setTag('graphql.operation.name', name)
}

/**
 * @param {{
 *   ddRequestRefined?: boolean,
 *   setTag: (key: string, value: string) => unknown
 * } | undefined} requestSpan
 * @param {import('graphql').DocumentNode | undefined} document
 * @param {unknown} requestSource
 * @param {string | null | undefined} operationName
 * @param {boolean} calculateSignature
 * @param {boolean} validated
 * @param {RequestCache | undefined} requestCache
 */
function refineRequestSpan (
  requestSpan,
  document,
  requestSource,
  operationName,
  calculateSignature,
  validated,
  requestCache
) {
  /* istanbul ignore if: validate only refines after the request span and parsed document exist. */
  if (!requestSpan || requestSpan.ddRequestRefined || !document) return

  const operation = getRequestOperation(document, operationName, calculateSignature)
  if (operation === undefined) return

  const { signature, type, name } = operation
  refineRequestSpanMetadata(requestSpan, signature, type, name)

  if (!validated || !requestCache || !isCacheableSource(requestSource)) return
  cacheRequestOperation(
    requestCache,
    requestSource,
    operationName,
    calculateSignature,
    operation,
    document
  )
}

/**
 * @param {RequestCache} requestCache
 * @param {string | object} source
 * @param {string | null | undefined} operationName
 * @param {boolean} calculateSignature
 * @param {RequestOperation} operation
 * @param {import('graphql').DocumentNode} document
 */
function cacheRequestOperation (
  requestCache,
  source,
  operationName,
  calculateSignature,
  operation,
  document
) {
  const operationKey = operationCacheKey(operationName, calculateSignature)
  const documentRef = new WeakRef(document)
  if (typeof source === 'string') {
    requestCache.operations.set(`${operationKey}\n${source}`, operation)
    requestCache.documents.set(source, documentRef)
    return
  }

  let cached = requestCache.documentOperations.get(source)
  if (cached === undefined) {
    cached = {
      document: documentRef,
      operations: new Map(),
    }
    requestCache.documentOperations.set(source, cached)
  } else {
    cached.document = documentRef
  }
  cached.operations.set(operationKey, operation)
}

/**
 * @param {import('graphql').DocumentNode} document
 * @param {string | null | undefined} operationName
 * @param {boolean} calculateSignature
 * @returns {RequestOperation | undefined}
 */
function getRequestOperation (document, operationName, calculateSignature) {
  const operation = getOperation(document, operationName)
  if (operation === undefined) return

  const type = operation.operation
  const name = operation.name?.value
  return {
    signature: getSignature(document, name, type, calculateSignature),
    type,
    name,
  }
}

/**
 * @param {{ errorExtensions?: string[] }} config Resolved plugin config; `errorExtensions` lists the
 *   GraphQL error `extensions` keys to copy onto the span event.
 * @param {import('../../dd-trace/src/opentracing/span')} span
 * @param {{ name?: string, message?: string, stack?: string, locations?: Array<{ line: number, column: number }>,
 *   path?: Array<string|number>, extensions?: Record<string, unknown> }} exc
 */
function extractErrorIntoSpanEvent (config, span, exc) {
  const attributes = {}

  if (exc.name) {
    attributes.type = exc.name
  }

  // graphql-js validation errors carry a lazy `.stack` accessor; reading it
  // here is the only consumer in the pipeline and pays full V8 symbolisation.
  const isValidationOnly = exc.locations && !exc.path && !exc.originalError?.stack
  if (!isValidationOnly && exc.stack) {
    attributes.stacktrace = exc.stack
  }

  if (exc.locations) {
    attributes.locations = []
    for (const location of exc.locations) {
      attributes.locations.push(`${location.line}:${location.column}`)
    }
  }

  if (exc.path) {
    attributes.path = exc.path.map(String)
  }

  if (exc.message) {
    attributes.message = exc.message
  }

  if (config.errorExtensions) {
    for (const ext of config.errorExtensions) {
      if (exc.extensions?.[ext]) {
        const value = exc.extensions[ext]

        // We should only stringify the value if it is not of type number or boolean
        if (typeof value === 'number' || typeof value === 'boolean') {
          attributes[`extensions.${ext}`] = value
        } else {
          attributes[`extensions.${ext}`] = String(value)
        }
      }
    }
  }

  span.addEvent('dd.graphql.query.error', attributes, Date.now())
}

// Apollo Gateway's fixed subgraph health-check query, sent verbatim on every
// poll interval. See https://github.com/apollographql/federation
// `HEALTH_CHECK_QUERY`.
const HEALTH_CHECK_QUERY = 'query __ApolloServiceHealthCheck__ { __typename }'

/**
 * Matches the raw query string before it is parsed (the only input parse has).
 *
 * @param {unknown} source Raw query string or a graphql `Source` body.
 * @returns {boolean}
 */
function isApolloHealthCheckSource (source) {
  return source === HEALTH_CHECK_QUERY
}

/**
 * Matches Apollo's parsed health-check operation exactly for cached documents.
 *
 * @param {import('graphql').OperationDefinitionNode | undefined} operation
 * @returns {boolean}
 */
function isApolloHealthCheck (operation) {
  const selections = operation?.selectionSet?.selections
  if (operation?.operation !== 'query' ||
      operation.name?.value !== '__ApolloServiceHealthCheck__' ||
      operation.variableDefinitions?.length ||
      operation.directives?.length ||
      selections?.length !== 1) {
    return false
  }

  const selection = selections[0]
  return selection.kind === 'Field' &&
    selection.name?.value === '__typename' &&
    selection.alias === undefined &&
    selection.selectionSet === undefined &&
    selection.arguments?.length === 0 &&
    selection.directives?.length === 0
}

/**
 * @param {import('graphql').GraphQLOutputType} type
 * @returns {string}
 */
function getBaseTypeName (type) {
  let current = type
  while ('ofType' in current) current = current.ofType
  return current.name
}

let tools

/**
 * @param {import('graphql').DocumentNode} document
 * @param {string | undefined} operationName
 * @param {import('graphql').OperationTypeNode} operationType
 * @param {boolean} [calculate]
 * @returns {string}
 */
function getSignature (document, operationName, operationType, calculate) {
  if (calculate !== false && tools !== false) {
    try {
      try {
        tools ||= require('./tools')
      } catch (e) {
        tools = false
        throw e
      }

      return tools.defaultEngineReportingSignature(document, operationName)
    } catch {
      // safety net
    }
  }

  if (operationName) {
    return `${operationType} ${operationName}`
  }
  return operationType
}

module.exports = {
  extractErrorIntoSpanEvent,
  getBaseTypeName,
  getCachedRequestOperation,
  getOperation,
  getRequestCache,
  getSignature,
  isApolloHealthCheck,
  isApolloHealthCheckSource,
  refineRequestSpan,
  refineRequestSpanMetadata,
}
