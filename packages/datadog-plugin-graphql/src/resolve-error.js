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
  const fieldNode = fieldNodes?.[0]
  const rootCtx = legacyStorage.getStore()?.graphqlRootCtx
  for (let field = rootCtx?.resolveFields; field; field = field.nextResolveField) {
    if ((!fieldNode || field.fieldNode === fieldNode) && matchesPath(field.pathString, path)) {
      recordResolveError(field, error)
      return
    }
  }
}

/**
 * @param {string} fieldPath
 * @param {(string | number)[]} path
 * @returns {boolean}
 */
function matchesPath (fieldPath, path) {
  let pathString = ''
  for (let index = 0; index < path.length; index++) {
    if (index !== 0) pathString += '.'
    pathString += typeof path[index] === 'number' ? '*' : path[index]
  }
  return pathString === fieldPath
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
