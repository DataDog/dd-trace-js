'use strict'

const { storage } = require('../../datadog-core')
const GraphQLExecutePlugin = require('./execute')
const GraphQLParsePlugin = require('./parse')
const GraphQLValidatePlugin = require('./validate')

const legacyStorage = storage('legacy')

/**
 * @typedef {import('graphql').GraphQLExecuteRootSelectionSetContext & {
 *   ddArgs?: import('graphql').ExecutionArgs,
 *   ddSkipped?: boolean,
 *   parentStore?: object,
 *   currentStore?: object,
 * }} NativeExecutionContext
 */

class NativeExecutePlugin extends GraphQLExecutePlugin {
  static prefix = 'tracing:graphql:execute:rootSelectionSet'
  static extraPrefixes = []

  addTraceSubs () {
    super.addTraceSubs()
    this.addBind('tracing:orchestrion:graphql:apm:graphql:execute:root:start', () => {
      const store = legacyStorage.getStore()
      if (store?.graphqlRootCtx?.executeSpan) {
        return { ...store, graphqlRewrittenRoot: true }
      }
      return store
    })
  }

  /** @param {NativeExecutionContext} ctx */
  readExecutionArgs (ctx) {
    const store = legacyStorage.getStore()
    const rewritten = store?.graphqlRewrittenRoot
    if (rewritten) {
      store.graphqlRewrittenRoot = undefined
    }

    if (rewritten || ctx.operationType === 'subscription') {
      ctx.ddSkipped = true
      ctx.currentStore = store
      return
    }

    const { schema, document, operationName, rawVariableValues } = ctx
    return { schema, document, operationName, variableValues: rawVariableValues }
  }

  /**
   * @param {NativeExecutionContext} ctx
   * @param {import('graphql').ExecutionArgs} args
   */
  startExecution (ctx, args) {
    // Root-selection events expose normalized execution data. The rewrite owns resolver wrapping.
    ctx.ddArgs = args
  }

  /** @param {NativeExecutionContext} ctx */
  end (ctx) {
    if (Object.hasOwn(ctx, 'result') || Object.hasOwn(ctx, 'error')) {
      return this.asyncEnd(ctx)
    }
    return ctx.parentStore
  }

  /** @param {NativeExecutionContext} ctx */
  asyncEnd (ctx) {
    return super.end(ctx)
  }

  /** @param {NativeExecutionContext} ctx */
  error (ctx) {
    if (!ctx.ddSkipped) super.error(ctx)
  }
}

class NativeParsePlugin extends GraphQLParsePlugin {
  static prefix = 'tracing:graphql:parse'
}

class NativeValidatePlugin extends GraphQLValidatePlugin {
  static prefix = 'tracing:graphql:validate'
}

module.exports = { NativeExecutePlugin, NativeParsePlugin, NativeValidatePlugin }
