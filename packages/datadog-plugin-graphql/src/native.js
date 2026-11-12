'use strict'

// GraphQL 17 publishes `graphql:*` tracing channels on every Node.js version and module format, so these
// plugins map their contexts onto the arguments the rewriter channels carry for earlier versions.

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const GraphQLExecutePlugin = require('./execute')
const GraphQLParsePlugin = require('./parse')
const { recordFieldError } = require('./resolve-error')
const GraphQLValidatePlugin = require('./validate')
const { getOperation } = require('./utils')

const { finishDefaultField, startDefaultField } = GraphQLExecutePlugin

class GraphQLNativeParsePlugin extends GraphQLParsePlugin {
  static prefix = 'tracing:graphql:parse'

  bindStart (ctx) {
    ctx.arguments = [ctx.source]
    return super.bindStart(ctx)
  }
}

class GraphQLNativeValidatePlugin extends GraphQLValidatePlugin {
  static prefix = 'tracing:graphql:validate'

  bindStart (ctx) {
    ctx.arguments = [ctx.schema, ctx.document]
    return super.bindStart(ctx)
  }
}

class GraphQLNativeExecutePlugin extends GraphQLExecutePlugin {
  static prefix = 'tracing:graphql:execute'
  static extraPrefixes = []

  bindStart (ctx) {
    const { schema, document, operationName } = ctx
    ctx.arguments = [{ schema, document, variableValues: ctx.rawVariableValues, operationName }]
    const store = super.bindStart(ctx)

    const rootCtx = ctx.ddRootCtx
    if (rootCtx) {
      rootCtx.native = true
      rootCtx.schema = schema
      rootCtx.document = document
      rootCtx.operation = getOperation(document, operationName)
    }
    return store
  }

  // GraphQL ignores a field resolver added to these arguments, so the execute hook gets them unchanged.
  wrapExecutionResolvers (ctx, args) {
    super.wrapExecutionResolvers(ctx, args)
    ctx.ddArgs = args
  }

  // A promise result is published on asyncEnd.
  end (ctx) {
    if (isSettled(ctx)) super.end(ctx)
  }

  asyncEnd (ctx) {
    super.end(ctx)
  }

  error (ctx) {
    ctx.ddFailed = true
    super.error(ctx)
  }
}

// Fields with their own resolver are traced by the schema resolver wrappers the execute plugin installs.
class GraphQLNativeResolvePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'resolve'
  static prefix = 'tracing:graphql:resolve'

  bindStart (ctx) {
    return startDefaultField(ctx)
  }

  end (ctx) {
    if (isSettled(ctx)) finishDefaultField(ctx)
  }

  asyncEnd (ctx) {
    finishDefaultField(ctx)
  }

  // Also attributes errors of resolvers that reuse a collapsed span.
  error (ctx) {
    ctx.ddFailed = true
    recordFieldError(ctx.error, ctx.fieldPath, ctx.parentType)
  }
}

/**
 * GraphQL publishes `end` with the result of a synchronous call, and on `asyncEnd` for a promise.
 *
 * @param {{ result?: unknown, ddFailed?: boolean }} ctx
 */
function isSettled (ctx) {
  return ctx.ddFailed === true || Object.hasOwn(ctx, 'result')
}

module.exports = {
  GraphQLNativeExecutePlugin,
  GraphQLNativeParsePlugin,
  GraphQLNativeResolvePlugin,
  GraphQLNativeValidatePlugin,
}
