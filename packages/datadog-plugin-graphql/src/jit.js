'use strict'

const { storage } = require('../../datadog-core')
const createGraphqlJitRuntime = require('../../datadog-instrumentations/src/helpers/graphql-jit-runtime')
const GraphQLExecutePlugin = require('./execute')
const { getBaseTypeName } = require('./utils')

const {
  readJitDefaultInScope,
  recordJitResolverError,
  resolveCompiledJitField,
  resolveJitDefaultInvocation,
  unwrapJitResolve,
  wrapJitResolve,
} = GraphQLExecutePlugin

/**
 * @typedef {import('graphql').ExecutionArgs} ExecutionArguments
 * @typedef {import('../../datadog-instrumentations/src/helpers/graphql-jit-runtime').JitPlan} JitPlan
 * @typedef {Record<string, import('graphql').GraphQLFieldResolver<unknown, unknown>>} GraphQLResolverMap
 * @typedef {{
 *   arguments: [unknown, unknown, Record<string, unknown> | undefined],
 *   currentStore: Record<string, unknown>,
 *   ddArgs?: ExecutionArguments,
 *   ddDocument: import('graphql').DocumentNode,
 *   ddOperationName?: string,
 *   ddPlan?: JitPlan,
 *   ddResolvers?: GraphQLResolverMap,
 *   ddSchema: import('graphql').GraphQLSchema
 * }} JitExecutionContext
 */

const graphqlJitCompilePrefix = 'tracing:orchestrion:graphql-jit:compile'
const legacyStorage = storage('legacy')
const patchedResolverMaps = new WeakSet()

const { configureCompilationContext, runtime: jitRuntime } = createGraphqlJitRuntime({
  createFieldMetadata,
  readDefaultInScope: readJitDefaultInScope,
  recordResolverError: recordJitResolverError,
  resolveDefaultInvocation: resolveJitDefaultInvocation,
  resolveField: resolveCompiledJitField,
  startExecution,
  unwrapResolver: unwrapJitResolve,
  wrapResolver: wrapJitResolve,
})

class GraphQLJitExecutePlugin extends GraphQLExecutePlugin {
  static prefix = 'tracing:orchestrion:graphql-jit:apm:graphql:execute'
  static extraPrefixes = []

  addTraceSubs () {
    super.addTraceSubs()
    this.addSub(`${graphqlJitCompilePrefix}:end`, configureCompilationContext)
  }

  /**
   * @param {JitExecutionContext} ctx
   * @returns {ExecutionArguments}
   */
  readExecutionArgs (ctx) {
    const [rootValue, contextValue, variableValues] = ctx.arguments
    return {
      schema: ctx.ddSchema,
      document: ctx.ddDocument,
      rootValue,
      contextValue,
      variableValues,
      operationName: ctx.ddOperationName,
    }
  }

  /**
   * @param {JitExecutionContext} ctx
   * @param {ExecutionArguments} args
   */
  wrapExecutionResolvers (ctx, args) {
    const { ddResolvers: resolvers } = ctx
    if (ctx.ddPlan === undefined && resolvers && !patchedResolverMaps.has(resolvers)) {
      patchedResolverMaps.add(resolvers)
      for (const name of Object.keys(resolvers)) {
        resolvers[name] = wrapJitResolve(resolvers[name])
      }
    }
    ctx.ddArgs = args
  }

  /**
   * @param {JitExecutionContext} ctx
   * @param {unknown} _contextValue
   * @param {object} rootCtx
   */
  storeRootContext (ctx, _contextValue, rootCtx) {
    ctx.currentStore.graphqlRootCtx = rootCtx
  }
}

/**
 * @param {Record<string, unknown> | undefined} variableValues
 * @returns {object | undefined}
 */
function startExecution (variableValues) {
  const rootCtx = legacyStorage.getStore()?.graphqlRootCtx
  if (!rootCtx) return

  rootCtx.variableValues = variableValues
  rootCtx.jitRuntime = jitRuntime
  return rootCtx
}

/**
 * @param {string} parentTypeName
 * @param {string} fieldName
 * @param {import('graphql').GraphQLOutputType} returnType
 * @param {string} collapsedPath
 * @returns {{
 *   baseTypeName: string,
 *   resource: string,
 *   tags: Record<string, string>
 * }}
 */
function createFieldMetadata (parentTypeName, fieldName, returnType, collapsedPath) {
  const baseTypeName = getBaseTypeName(returnType)
  return {
    baseTypeName,
    resource: `${fieldName}:${returnType}`,
    tags: {
      'graphql.field.coordinates': `${parentTypeName}.${fieldName}`,
      'graphql.field.name': fieldName,
      'graphql.field.path': collapsedPath,
      'graphql.field.type': baseTypeName,
    },
  }
}

module.exports = GraphQLJitExecutePlugin
