'use strict'

const { storage } = require('../../datadog-core')
const createGraphqlJitRuntime = require('../../datadog-instrumentations/src/helpers/graphql-jit-runtime')
const GraphQLExecutePlugin = require('./execute')

const { JIT_FIELD_NAME, resolveJitDefaultInvocation, wrapJitResolve } = GraphQLExecutePlugin

/**
 * @typedef {import('graphql').ExecutionArgs} ExecutionArguments
 * @typedef {Record<string, import('graphql').GraphQLFieldResolver<unknown, unknown>>} GraphQLResolverMap
 * @typedef {{
 *   id: number,
 *   arguments: import('graphql').GraphQLArgument[],
 *   baseTypeName?: string,
 *   collapsedPath: string,
 *   fieldName: string,
 *   fieldNode: import('graphql').FieldNode,
 *   parentId?: number,
 *   parentTypeName: string,
 *   pathDepth: number,
 *   resource?: string,
 *   returnType: import('graphql').GraphQLOutputType,
 *   selectionDepth: number,
 *   tags?: Record<string, string | undefined>
 * }} JitFieldDescriptor
 * @typedef {{
 *   fields: JitFieldDescriptor[],
 *   fieldsByPath?: Map<string, JitFieldDescriptor>,
 *   finalized: boolean
 * }} JitPlan
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

const graphqlJitCompileContextPrefix = 'tracing:orchestrion:graphql-jit:apm:graphql:compile:context'
const legacyStorage = storage('legacy')
const patchedResolverMaps = new WeakSet()

const { configureCompilationContext, runtime: jitRuntime } = createGraphqlJitRuntime({
  descriptorKey: JIT_FIELD_NAME,
  finalizeFieldDescriptor,
  resolveDefaultInvocation: resolveJitDefaultInvocation,
  startExecution,
})

class GraphQLJitExecutePlugin extends GraphQLExecutePlugin {
  static prefix = 'tracing:orchestrion:graphql-jit:apm:graphql:execute'
  static extraPrefixes = []

  addTraceSubs () {
    super.addTraceSubs()
    this.addSub(`${graphqlJitCompileContextPrefix}:end`, configureCompilationContext)
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
    if (resolvers && !patchedResolverMaps.has(resolvers)) {
      patchedResolverMaps.add(resolvers)
      for (const name of Object.keys(resolvers)) {
        resolvers[name] = wrapJitResolve(resolvers[name])
      }
    }
    ctx.ddArgs = args
  }

  /**
   * The transformed JIT wrapper throws after the start channel returns.
   *
   * @param {JitExecutionContext} _ctx
   */
  abortExecution (_ctx) {}

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
 * @param {JitFieldDescriptor} descriptor
 */
function finalizeFieldDescriptor (descriptor) {
  const { baseTypeName, collapsedPath, fieldName, parentTypeName, returnType } = descriptor
  descriptor.resource = `${fieldName}:${returnType}`
  descriptor.tags = {
    'graphql.field.coordinates': `${parentTypeName}.${fieldName}`,
    'graphql.field.name': fieldName,
    'graphql.field.path': collapsedPath,
    'graphql.field.type': baseTypeName,
  }
}

module.exports = GraphQLJitExecutePlugin
