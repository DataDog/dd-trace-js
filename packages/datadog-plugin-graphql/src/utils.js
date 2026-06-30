'use strict'

const { LRUCache } = require('../../../vendor/dist/lru-cache')

// Mercurius funnels every operation through `fastifyGraphQl`, but the parsed
// document — and therefore the operation signature/type/name — is only known
// once execute runs. On the JIT warm path execute never fires, so the top-level
// request span would otherwise be left with only the provisional resource. The
// cold path caches the computed metadata keyed by the raw query text (the same
// key mercurius uses for its own LRU); the request boundary reads it back on the
// warm path. Bounded so a flood of distinct queries can't grow it without limit.
const requestOperationCache = new LRUCache({ max: 500 })

/**
 * @param {string} source - The raw query text; the same key mercurius uses.
 * @param {{ signature?: string, type?: string, name?: string }} operation
 */
function cacheRequestOperation (source, operation) {
  requestOperationCache.set(source, operation)
}

/**
 * @param {string | undefined} source - undefined for a pre-parsed AST source.
 * @returns {{ signature?: string, type?: string, name?: string } | undefined}
 */
function getCachedRequestOperation (source) {
  return requestOperationCache.get(source)
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
