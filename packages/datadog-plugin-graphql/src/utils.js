'use strict'

const { LRUCache } = require('../../../vendor/dist/lru-cache')

/**
 * @typedef {{ signature?: string, type?: string, name?: string }} RequestOperation
 */

const operationTypes = new Set(['query', 'mutation', 'subscription'])

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
const requestOperationCache = new LRUCache({ max: 500 })

// Mercurius also accepts a pre-parsed document AST as the source, which reaches
// the request boundary as an object rather than query text — so there is no
// string to key the LRU by. Mercurius keys its own document LRU by that source
// object's identity, and the same object reaches the boundary on the warm path,
// so a WeakMap keyed by the caller-owned document recovers the metadata without
// mutating the document and releases with it. The value carries the requested
// operation name so a JIT-only sibling selection is not handed another
// operation's metadata (same reason the string cache keys by operation name).
/** @type {WeakMap<object, Map<string | undefined, RequestOperation>>} */
const documentOperationCache = new WeakMap()

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
 * @returns {RequestOperation | undefined}
 */
function getCachedRequestOperation (source, operationName) {
  if (typeof source === 'string') {
    return requestOperationCache.get(requestOperationKey(source, operationName))
  }
  if (source === null || typeof source !== 'object') return
  return documentOperationCache.get(source)?.get(operationName)
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
 * Refine the top-level graphql.request span (mercurius) from the parsed
 * document and cache the metadata so the JIT warm path — where no sub-span
 * fires — can recover the same tags at the request boundary.
 *
 * This runs at the first boundary that has the document (validate on the cold
 * path, which also precedes a pre-execute validation failure). It is idempotent
 * across the later execute boundary via the `ddRequestRefined` flag, and a
 * no-op for graphql-js/apollo/yoga, which never open a request span.
 *
 * Every named operation in the document is cached, not just the selected one:
 * a multi-operation document parses once, and a later request may select a
 * sibling operation that mercurius then serves exclusively through its JIT path
 * (no execute span), so its metadata has to be ready before that happens.
 *
 * @param {import('../../dd-trace/src/opentracing/span') | undefined} requestSpan
 * @param {import('graphql').DocumentNode | undefined} document
 * @param {unknown} requestSource - The raw source the request boundary saw:
 *   query text on the common path, a pre-parsed document AST otherwise. The
 *   cache is keyed by it, not by the parsed document, so the request boundary
 *   recovers the metadata on the warm path from the same value mercurius keys
 *   its own document LRU by. Any other shape has no usable key and is not
 *   cached (the warm path never reaches this span for it either).
 * @param {string | undefined} operationName - The requested operation name.
 * @param {boolean} calculateSignature - The graphql plugin's `signature` config.
 */
function refineRequestSpan (requestSpan, document, requestSource, operationName, calculateSignature) {
  /* istanbul ignore if: validate only refines after the request span and parsed document exist. */
  if (!requestSpan || requestSpan.ddRequestRefined || !document) return
  requestSpan.ddRequestRefined = true

  const operation = getOperation(document, operationName)
  const type = operation?.operation
  const name = operation?.name?.value
  const signature = getSignature(document, name, type, calculateSignature)

  if (signature) requestSpan.setTag('resource.name', signature)
  if (type) requestSpan.setTag('graphql.operation.type', type)
  if (name) requestSpan.setTag('graphql.operation.name', name)

  if (!isCacheableSource(requestSource)) return

  // Cache the selected operation under the requested name (undefined selects
  // the document's first operation, so it shares the entry with that name).
  cacheRequestOperation(requestSource, operationName, { signature, type, name })

  // Cache every named operation so a JIT-only sibling selection is labeled from
  // this single parse instead of falling back to a bare operation name.
  for (const definition of document.definitions) {
    const definitionName = definition?.name?.value
    if (definitionName === undefined || !operationTypes.has(definition.operation)) continue
    if (definitionName === operationName) continue

    cacheRequestOperation(requestSource, definitionName, {
      signature: getSignature(document, definitionName, definition.operation, calculateSignature),
      type: definition.operation,
      name: definitionName,
    })
  }
}

/**
 * @param {string | import('graphql').DocumentNode} source - Query text keys the
 *   text LRU; a caller-owned document AST keys the WeakMap (never mutated).
 * @param {string | undefined} operationName - The requested operation name.
 * @param {RequestOperation} operation
 */
function cacheRequestOperation (source, operationName, operation) {
  if (typeof source === 'string') {
    requestOperationCache.set(requestOperationKey(source, operationName), operation)
    return
  }

  let operations = documentOperationCache.get(source)
  if (operations === undefined) {
    operations = new Map()
    documentOperationCache.set(source, operations)
  }
  operations.set(operationName, operation)
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
  getCachedRequestOperation,
  getOperation,
  getSignature,
  isApolloHealthCheck,
  isApolloHealthCheckSource,
  refineRequestSpan,
}
