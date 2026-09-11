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
  if (!rootCtx?.config.collapse || !rootCtx.fields) return

  const field = findResolveField(rootCtx.fields, getPathString(path), fieldNodes?.[0])
  if (field) recordResolveError(field, error)
}

/**
 * @param {(string | number)[]} path
 * @returns {string}
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
 * @returns {object | undefined}
 */
function findResolveField (fields, pathString, fieldNode) {
  const field = fields.get(pathString)
  if (field === undefined) return

  const parentTypeFields = field.parentTypeFields
  if (parentTypeFields === undefined) {
    return fieldNode === undefined || field.fieldNode === fieldNode ? field : undefined
  }
  if (parentTypeFields.parentTypeName !== undefined) {
    if (fieldNode === undefined || parentTypeFields.fieldNode === fieldNode) return parentTypeFields
    return field.fieldNode === fieldNode ? field : undefined
  }

  let matchingField
  for (const candidate of parentTypeFields.values()) {
    if (fieldNode === undefined || candidate.fieldNode === fieldNode) matchingField = candidate
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
  recordResolveError,
}
