'use strict'

const { LRUCache } = require('../../../vendor/dist/lru-cache')

/**
 * @typedef {{ signature?: string, type?: string, name?: string }} RequestOperation
 */

const operationTypes = new Set(['query', 'mutation', 'subscription'])
const requestCacheMax = 500

// Mercurius funnels every operation through `fastifyGraphQl`, but the parsed
// document — and therefore the operation signature/type/name — is only known
// once mercurius parses internally. The top-level request span opens before
// that, and on the JIT warm path neither parse/validate nor execute fires, so
// the span would otherwise be left with only the provisional resource. The cold
// path caches the computed metadata; the request boundary reads it back on the
// warm path. Bounded so a flood of distinct queries can't grow it without limit.
//
// The key is the operation name plus the raw query text, not the source alone:
// mercurius keys its document LRU by source but compiles the JIT for a single
// `operationName`, and the compiled query then serves that operation for every
// later request that shares the source — regardless of the `operationName` those
// requests ask for. A source-only key would hand a warm request for operation B
// the metadata of whichever operation was cached last for that source (A),
// mislabeling the span. Operation names cannot contain a newline, so it is a
// safe separator that keeps the two parts from colliding.
// A validated document lets a later JIT-only sibling calculate only its requested signature.
// Keep it weak so the tracer never extends its lifetime beyond mercurius's own cache.
// Mercurius also accepts a pre-parsed document AST as the source, which reaches
// the request boundary as an object rather than query text — so there is no
// string to key the LRU by. Mercurius keys its own document LRU by that source
// object's identity, and the same object reaches the boundary on the warm path,
// so a WeakMap keyed by the caller-owned document retains the validated clone
// and lazily calculated operation metadata without mutating the source. It
// releases with the source object.
/**
 * @typedef {{
 *   document?: WeakRef<import('graphql').DocumentNode>,
 *   operations: Map<string | undefined, RequestOperation>
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
 * @param {string} source - The raw query text; the same key mercurius uses.
 * @param {string | undefined} operationName - The requested operation name.
 * @returns {string}
 */
function requestOperationKey (source, operationName) {
  return `${operationName ?? ''}\n${source}`
}

/**
 * @param {unknown} source - Query text on the common path; a pre-parsed
 *   document AST otherwise. Any other shape (mercurius rejects it before
 *   execute) has no cache entry and yields undefined.
 * @param {string | undefined} operationName - The requested operation name.
 * @param {boolean} calculateSignature - The graphql plugin's `signature` config.
 * @param {RequestCache | undefined} requestCache
 * @returns {RequestOperation | undefined}
 */
function getCachedRequestOperation (source, operationName, calculateSignature, requestCache) {
  if (requestCache === undefined) return

  if (typeof source === 'string') {
    const key = requestOperationKey(source, operationName)
    let operation = requestCache.operations.get(key)
    if (operation !== undefined) return operation

    const document = requestCache.documents.get(source)?.deref()
    if (document === undefined) return

    operation = getRequestOperation(document, operationName, calculateSignature)
    requestCache.operations.set(key, operation)
    return operation
  }
  if (source === null || typeof source !== 'object') return

  const cached = requestCache.documentOperations.get(source)
  if (cached === undefined) return

  let operation = cached.operations.get(operationName)
  const document = cached.document?.deref()
  if (operation !== undefined || document === undefined) return operation

  operation = getRequestOperation(document, operationName, calculateSignature)
  cached.operations.set(operationName, operation)
  return operation
}

/**
 * A string source keys the text LRU; a document AST keys the WeakMap. Any other
 * shape has no usable key — mercurius rejects it before execute, so the warm
 * path never reaches the request span for it either.
 *
 * @param {unknown} source
 * @returns {source is string | object}
 */
function isCacheableSource (source) {
  return typeof source === 'string' || (source !== null && typeof source === 'object')
}

/**
 * Select the operation definition matching `operationName`, or the first one
 * when no name is given (graphql/mercurius default selection).
 *
 * @param {import('graphql').DocumentNode | undefined} document
 * @param {string | undefined} operationName
 * @returns {import('graphql').OperationDefinitionNode | undefined}
 */
function getOperation (document, operationName) {
  /* istanbul ignore if: validate/execute only call this with a parsed GraphQL document. */
  if (!document || !Array.isArray(document.definitions)) return

  for (const definition of document.definitions) {
    if (operationTypes.has(definition?.operation) &&
        (!operationName || definition.name?.value === operationName)) {
      return definition
    }
  }
}

/**
 * @param {import('../../dd-trace/src/opentracing/span') | undefined} requestSpan
 * @param {string} signature
 * @param {string | undefined} type
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
 * Refine the top-level graphql.request span (mercurius) from the parsed
 * document and cache the metadata so the JIT warm path — where no sub-span
 * fires — can recover the same tags at the request boundary.
 *
 * This runs at the first boundary that has the document (validate on the cold
 * path, which also precedes a pre-execute validation failure). It is idempotent
 * across the later execute boundary via the `ddRequestRefined` flag, and a
 * no-op for graphql-js/apollo/yoga, which never open a request span.
 *
 * A successfully validated document is retained so a later request selecting
 * a JIT-only sibling can derive only that sibling's metadata at the request
 * boundary, without reparsing, revalidating, or eagerly signing every sibling.
 *
 * @param {{
 *   ddRequestRefined?: boolean,
 *   setTag: (key: string, value: string) => unknown
 * } | undefined} requestSpan
 * @param {import('graphql').DocumentNode | undefined} document
 * @param {unknown} requestSource - The raw source the request boundary saw:
 *   query text on the common path, a pre-parsed document AST otherwise. The
 *   cache is keyed by it, not by the parsed document, so the request boundary
 *   recovers the metadata on the warm path from the same value mercurius keys
 *   its own document LRU by. Any other shape has no usable key and is not
 *   cached (the warm path never reaches this span for it either).
 * @param {string | undefined} operationName - The requested operation name.
 * @param {boolean} calculateSignature - The graphql plugin's `signature` config.
 * @param {boolean} validated - Whether graphql validation completed without errors.
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
  requestSpan.ddRequestRefined = true

  const operation = getRequestOperation(document, operationName, calculateSignature)
  const { signature, type, name } = operation

  if (signature) requestSpan.setTag('resource.name', signature)
  if (type) requestSpan.setTag('graphql.operation.type', type)
  if (name) requestSpan.setTag('graphql.operation.name', name)

  if (!requestCache || !isCacheableSource(requestSource)) return

  cacheRequestOperation(requestCache, requestSource, operationName, operation, validated ? document : undefined)
}

/**
 * @param {RequestCache} requestCache
 * @param {string | import('graphql').DocumentNode} source - Query text keys the
 *   text LRU; a caller-owned document AST keys the WeakMap (never mutated).
 * @param {string | undefined} operationName - The requested operation name.
 * @param {RequestOperation} operation
 * @param {import('graphql').DocumentNode | undefined} document - Retained only after successful validation.
 */
function cacheRequestOperation (requestCache, source, operationName, operation, document) {
  if (typeof source === 'string') {
    requestCache.operations.set(requestOperationKey(source, operationName), operation)
    if (document !== undefined) {
      requestCache.documents.set(source, new WeakRef(document))
    }
    return
  }

  let cached = requestCache.documentOperations.get(source)
  if (cached === undefined) {
    cached = { operations: new Map() }
    requestCache.documentOperations.set(source, cached)
  }
  if (document !== undefined) {
    cached.document = new WeakRef(document)
  }
  cached.operations.set(operationName, operation)
}

/**
 * @param {import('graphql').DocumentNode} document
 * @param {string | undefined} operationName
 * @param {boolean} calculateSignature
 * @returns {RequestOperation}
 */
function getRequestOperation (document, operationName, calculateSignature) {
  const operation = getOperation(document, operationName)
  const type = operation?.operation
  const name = operation?.name?.value
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

  if (operationType) {
    if (operationName) {
      return `${operationType} ${operationName}`
    }
    return operationType
  }

  return operationName ?? ''
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
