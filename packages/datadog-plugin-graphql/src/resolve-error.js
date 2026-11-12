'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const legacyStorage = storage('legacy')
const normalizedFalsyErrors = new WeakSet()

class GraphQLResolveErrorPlugin extends TracingPlugin {
  static id = 'graphql'
  static prefix = 'tracing:orchestrion:graphql:apm:graphql:resolve:error'

  /**
   * @param {{ arguments?: unknown[], result?: unknown }} ctx
   */
  start (ctx) {
    const args = ctx.arguments
    if (args?.length === 1) return

    const error = args?.[0]
    const errorPath = error?.path
    const path = Array.isArray(errorPath) ? errorPath : args?.[2]
    if (path) {
      recordResolveErrorForPath(normalizedFalsyErrors.delete(error) ? undefined : error, path, args?.[1])
    }
  }

  /**
   * @param {{ arguments?: unknown[], result?: unknown }} ctx
   */
  end (ctx) {
    const args = ctx.arguments
    if (args?.length !== 1 || args[0]) return

    const error = ctx.result
    if (error !== null && typeof error === 'object') normalizedFalsyErrors.add(error)
  }
}

class GraphQLToolsResolveErrorPlugin extends TracingPlugin {
  static id = 'graphql'
  static prefix = 'tracing:orchestrion:@graphql-tools/executor:apm:graphql:resolve:error'

  /**
   * @param {{ arguments?: unknown[] }} ctx
   */
  start (ctx) {
    const error = ctx.arguments?.[0]
    if (error?.path) {
      recordResolveErrorForPath(error, error.path)
    }
  }

  // `start` owns attribution while the normalized error path is available.
  error () {}
}

/**
 * @param {unknown} error
 * @param {(string | number)[]} path
 * @param {readonly object[]} [fieldNodes]
 */
function recordResolveErrorForPath (error, path, fieldNodes) {
  const rootCtx = legacyStorage.getStore()?.graphqlRootCtx
  if (!rootCtx?.config?.collapse || !rootCtx.fields) return

  const field = findResolveField(rootCtx.fields, getPathString(path), fieldNodes?.[0])
  if (field) recordResolveError(field, error)
}

/**
 * Records a GraphQL 17 resolver error, reported by its `graphql:resolve` channel, on its collapsed field.
 *
 * @param {unknown} error
 * @param {string} fieldPath Dotted response path.
 * @param {string} parentTypeName
 */
function recordFieldError (error, fieldPath, parentTypeName) {
  const rootCtx = legacyStorage.getStore()?.graphqlRootCtx
  if (!rootCtx?.config?.collapse || !rootCtx.fields) return

  // Like locatedError(), an error that already carries a path belongs to that path.
  const errorPath = /** @type {{ path?: unknown } | undefined} */ (error)?.path
  const path = Array.isArray(errorPath)
    ? errorPath
    : fieldPath.split('.').map(key => (key.charCodeAt(0) <= 57 ? Number(key) : key))
  const field = findResolveField(rootCtx.fields, getPathString(path), undefined, parentTypeName)
  if (field) recordResolveError(field, error)
}

/**
 * @param {(string | number)[]} path
 */
function getPathString (path) {
  let pathString = ''
  for (let index = 0; index < path.length; index++) {
    if (index !== 0) pathString += '.'
    pathString += typeof path[index] === 'number' ? '*' : path[index]
  }
  return pathString
}

/**
 * @param {Map<unknown, object>} fields
 * @param {string} pathString
 * @param {object} [fieldNode]
 * @param {string} [parentTypeName]
 * @returns {object | undefined}
 */
function findResolveField (fields, pathString, fieldNode, parentTypeName) {
  const field = fields.get(pathString)
  if (field === undefined) return

  const matches = candidate => (fieldNode === undefined || candidate.fieldNode === fieldNode) &&
    (parentTypeName === undefined || candidate.parentTypeName === parentTypeName)
  const parentTypeFields = field.parentTypeFields
  if (parentTypeFields === undefined) {
    return matches(field) ? field : undefined
  }
  if (parentTypeFields.parentTypeName !== undefined) {
    if (matches(parentTypeFields)) return parentTypeFields
    return matches(field) ? field : undefined
  }

  let matchingField
  for (const candidate of parentTypeFields.values()) {
    if (matches(candidate)) matchingField = candidate
  }
  return matchingField
}

/**
 * @param {object} field
 * @param {unknown} error
 */
function recordResolveError (field, error) {
  if (field.error !== undefined) return

  const recordedError = error || new Error('GraphQL resolver rejected without an error')
  field.error = recordedError
  field.span.setTag('error', recordedError)
  if (field.resolveHookContext) {
    field.resolveHookContext.error = recordedError
    field.resolveHookContext.result = undefined
  }
}

module.exports = {
  GraphQLResolveErrorPlugin,
  GraphQLToolsResolveErrorPlugin,
  recordFieldError,
  recordResolveError,
}
