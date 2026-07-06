'use strict'

const { LRUCache } = require('../../../vendor/dist/lru-cache')

// Mercurius funnels every operation through `fastifyGraphQl`, but the parsed
// document — and therefore the operation signature/type/name — is only known
// once execute runs. On the JIT warm path execute never fires, so the top-level
// request span would otherwise be left with only the provisional resource. The
// cold path caches the computed metadata; the request boundary reads it back on
// the warm path. Bounded so a flood of distinct queries can't grow it without
// limit.
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
 * @param {string} source - The raw query text; the same key mercurius uses.
 * @param {string | undefined} operationName - The requested operation name.
 * @param {{ signature?: string, type?: string, name?: string }} operation
 */
function cacheRequestOperation (source, operationName, operation) {
  requestOperationCache.set(requestOperationKey(source, operationName), operation)
}

/**
 * @param {string | undefined} source - undefined for a pre-parsed AST source.
 * @param {string | undefined} operationName - The requested operation name.
 * @returns {{ signature?: string, type?: string, name?: string } | undefined}
 */
function getCachedRequestOperation (source, operationName) {
  if (source === undefined) return
  return requestOperationCache.get(requestOperationKey(source, operationName))
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
  cacheRequestOperation,
  extractErrorIntoSpanEvent,
  getCachedRequestOperation,
  getSignature,
}
