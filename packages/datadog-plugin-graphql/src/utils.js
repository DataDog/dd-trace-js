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

/**
 * @param {string} source - The raw query text; the same key mercurius uses.
 * @param {string | undefined} operationName - The requested operation name.
 * @returns {string}
 */
function requestOperationKey (source, operationName) {
  return `${operationName ?? ''}\n${source}`
}

/**
 * @param {string | undefined} source - undefined for a pre-parsed AST source.
 * @param {string | undefined} operationName - The requested operation name.
 * @returns {RequestOperation | undefined}
 */
function getCachedRequestOperation (source, operationName) {
  if (source === undefined) return
  return requestOperationCache.get(requestOperationKey(source, operationName))
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
 * @param {string | undefined} docSource - undefined for a pre-parsed AST source.
 * @param {string | undefined} operationName - The requested operation name.
 * @param {boolean} calculateSignature - The graphql plugin's `signature` config.
 */
function refineRequestSpan (requestSpan, document, docSource, operationName, calculateSignature) {
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

  if (docSource === undefined) return

  // Cache the selected operation under the requested name (undefined selects
  // the document's first operation, so it shares the entry with that name).
  cacheRequestOperation(docSource, operationName, { signature, type, name })

  // Cache every named operation so a JIT-only sibling selection is labeled from
  // this single parse instead of falling back to a bare operation name.
  for (const definition of document.definitions) {
    const definitionName = definition?.name?.value
    if (definitionName === undefined || !operationTypes.has(definition.operation)) continue
    if (definitionName === operationName) continue

    cacheRequestOperation(docSource, definitionName, {
      signature: getSignature(document, definitionName, definition.operation, calculateSignature),
      type: definition.operation,
      name: definitionName,
    })
  }
}

/**
 * @param {string} source - The raw query text; the same key mercurius uses.
 * @param {string | undefined} operationName - The requested operation name.
 * @param {RequestOperation} operation
 */
function cacheRequestOperation (source, operationName, operation) {
  requestOperationCache.set(requestOperationKey(source, operationName), operation)
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
  refineRequestSpan,
}
