'use strict'

const operationTypes = new Set(['query', 'mutation', 'subscription'])

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
 * Refines a mercurius request span at the first boundary with a parsed document:
 * validate on the cold path, or graphql-jit execute on the warm path.
 *
 * @param {import('../../dd-trace/src/opentracing/span') | undefined} requestSpan
 * @param {import('graphql').DocumentNode | undefined} document
 * @param {string | undefined} operationName - The requested operation name.
 * @param {boolean} calculateSignature - The graphql plugin's `signature` config.
 */
function refineRequestSpan (requestSpan, document, operationName, calculateSignature) {
  /* istanbul ignore if: downstream boundaries only refine with a request span and parsed document. */
  if (!requestSpan || requestSpan.ddRequestRefined || !document) return
  requestSpan.ddRequestRefined = true

  const operation = getOperation(document, operationName)
  const type = operation?.operation
  const name = operation?.name?.value
  const signature = getSignature(document, name, type, calculateSignature)

  if (signature) requestSpan.setTag('resource.name', signature)
  if (type) requestSpan.setTag('graphql.operation.type', type)
  if (name) requestSpan.setTag('graphql.operation.name', name)
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
  getOperation,
  getSignature,
  isApolloHealthCheck,
  isApolloHealthCheckSource,
  refineRequestSpan,
}
