'use strict'

const { storage } = require('../../datadog-core')
const GraphQLExecutePlugin = require('./execute')

const { JIT_FIELD_NAME, resolveJitDefaultInvocation, wrapJitResolve } = GraphQLExecutePlugin

/**
 * @typedef {import('graphql').ExecutionArgs} ExecutionArguments
 * @typedef {Record<string, import('graphql').GraphQLFieldResolver<unknown, unknown>>} GraphQLResolverMap
 * @typedef {{ prev?: CompilerPath, key: string, type: 'literal' | 'meta' | 'variable' }} CompilerPath
 * @typedef {{
 *   fieldName: string,
 *   fieldNodes: import('graphql').FieldNode[],
 *   returnType: import('graphql').GraphQLOutputType,
 *   parentType: import('graphql').GraphQLCompositeType,
 *   arguments?: import('graphql').GraphQLArgument[]
 * }} ResolverInfoInput
 * @typedef {{
 *   id: number,
 *   arguments: import('graphql').GraphQLArgument[],
 *   baseTypeName?: string,
 *   collapsedPath: string,
 *   fieldName: string,
 *   fieldNode: import('graphql').FieldNode,
 *   parentId?: number,
 *   parentPathKey?: string,
 *   parentTypeName: string,
 *   pathDepth: number,
 *   resource: string,
 *   returnType: import('graphql').GraphQLOutputType,
 *   selectionDepth: number,
 *   tags: Record<string, string | undefined>
 * }} JitFieldDescriptor
 * @typedef {{
 *   fields: JitFieldDescriptor[],
 *   fieldsByPath?: Map<string, JitFieldDescriptor>,
 *   finalized: boolean
 * }} JitPlan
 * @typedef {{
 *   ddTraceDefaultResolvers?: boolean,
 *   ddTracePlan?: JitPlan,
 *   ddTraceRuntime?: typeof jitRuntime,
 *   options: { resolverInfoEnricher?: (input: ResolverInfoInput) => object },
 * }} JitCompilationContext
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

const jitRuntime = {
  compileDefaultField,
  createResolverInfoEnricher,
  getPlan,
  resolveDefaultInvocation: resolveJitDefaultInvocation,
  startExecution,
}

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
 * @param {{ result?: JitCompilationContext }} message
 */
function configureCompilationContext (message) {
  const context = message.result
  if (!context) return

  context.ddTraceDefaultResolvers = true
  context.ddTraceRuntime = jitRuntime
  context.ddTracePlan = {
    fields: [],
    fieldsByPath: new Map(),
    finalized: false,
  }
}

/**
 * @param {JitCompilationContext} context
 * @param {CompilerPath} responsePath
 * @param {import('graphql').GraphQLCompositeType} parentType
 * @param {{
 *   name: string,
 *   type: import('graphql').GraphQLOutputType,
 *   args: import('graphql').GraphQLArgument[]
 * }} field
 * @param {[import('graphql').FieldNode, ...import('graphql').FieldNode[]]} fieldNodes
 * @param {string[]} originPaths
 * @param {string} compiledField
 * @returns {string}
 */
function compileDefaultField (
  context,
  responsePath,
  parentType,
  field,
  fieldNodes,
  originPaths,
  compiledField
) {
  const descriptor = createDescriptor(context, responsePath, {
    arguments: field.args,
    fieldName: field.name,
    fieldNodes,
    returnType: field.type,
    parentType,
  }, fieldNodes[0])
  const parentPath = originPaths.join('.')
  const directRead = `${parentPath}?.${field.name}`
  /* c8 ignore next: graphql-jit compiles every field before the plan closes. */
  if (descriptor === undefined) return `((__ddValue) => ${compiledField})(${directRead})`

  const runtimePath = getRuntimePath(responsePath)

  // Field names, response keys, and graphql-jit's index segments already conform to identifier grammar.
  // The repeated `__context.ddTrace` loads are deliberate: binding it in an enclosing arrow
  // costs more than re-reading it.
  return `((__ddValue) => ${compiledField})(
    __context.ddTrace === undefined
      ? ${directRead}
      : (
        __context.ddTrace.jitTraceAll ||
        (__context.ddTrace.jitTraceFirst && __context.ddTrace.jitFields[${descriptor.id}] === undefined)
      )
        ? __context.ddTrace.jitRuntime.resolveDefaultInvocation(
          __context.ddTrace,
          ${descriptor.id},
          ${parentPath},
          __context.ddTrace.config.collapse ? undefined : ${runtimePath}
        )
        : ${directRead}
  )`
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
 * @param {JitCompilationContext} context
 * @param {CompilerPath} responsePath
 * @param {(input: ResolverInfoInput) => object} [userEnricher]
 * @returns {(input: ResolverInfoInput) => object}
 */
function createResolverInfoEnricher (context, responsePath, userEnricher) {
  /**
   * @param {ResolverInfoInput} input
   * @returns {object}
   */
  function enrichResolverInfo (input) {
    const enriched = userEnricher?.(input)
    const userFields = enriched && typeof enriched === 'object' && !Array.isArray(enriched) ? enriched : undefined
    const fieldNode = input.fieldNodes?.[0]
    if (fieldNode?.name.value !== input.fieldName) return userFields ?? {}

    const descriptor = createDescriptor(context, responsePath, input, fieldNode)
    /* c8 ignore next: graphql-jit compiles every field before the plan closes. */
    if (descriptor === undefined) return userFields ?? {}
    if (userFields === undefined) return { [JIT_FIELD_NAME]: descriptor }
    return addJitField(userFields, descriptor)
  }

  return enrichResolverInfo
}

/**
 * Preserve the caller's enrichment object and its property access timing. graphql-jit
 * enumerates it at compilation and reads each value when constructing resolve info.
 *
 * @param {object} userFields
 * @param {JitFieldDescriptor} descriptor
 * @returns {object}
 */
function addJitField (userFields, descriptor) {
  return new Proxy(Object.create(null), {
    /**
     * @returns {(string | symbol)[]}
     */
    ownKeys () {
      const userKeys = Reflect.ownKeys(userFields)
      const keys = []
      for (const key of userKeys) {
        if (key !== JIT_FIELD_NAME) keys.push(key)
      }
      keys.push(JIT_FIELD_NAME)
      return keys
    },
    /**
     * @param {object} _target
     * @param {string | symbol} key
     * @returns {PropertyDescriptor | undefined}
     */
    getOwnPropertyDescriptor (_target, key) {
      if (key === JIT_FIELD_NAME) {
        return {
          configurable: true,
          enumerable: true,
          value: descriptor,
          writable: false,
        }
      }

      const property = Reflect.getOwnPropertyDescriptor(userFields, key)
      return property && { ...property, configurable: true }
    },
    /**
     * @param {object} _target
     * @param {string | symbol} key
     * @returns {unknown}
     */
    get (_target, key) {
      if (key === JIT_FIELD_NAME) return descriptor
      return Reflect.get(userFields, key, userFields)
    },
  })
}

/**
 * @param {JitCompilationContext} context
 * @returns {JitPlan | undefined}
 */
function getPlan (context) {
  const plan = context.ddTracePlan
  if (!plan || plan.finalized) return plan

  const fieldsByPath = plan.fieldsByPath
  for (const field of plan.fields) {
    field.parentId = fieldsByPath?.get(field.parentPathKey)?.id
    field.parentPathKey = undefined
  }
  plan.fieldsByPath = undefined
  plan.finalized = true
  return plan
}

/**
 * graphql-jit compiles queries before subscriptions, so a descriptor requested after the plan
 * closed cannot be tracked; the field then compiles and resolves exactly as it would untraced.
 *
 * @param {JitCompilationContext} context
 * @param {CompilerPath} responsePath
 * @param {ResolverInfoInput} input
 * @param {import('graphql').FieldNode} fieldNode
 * @returns {JitFieldDescriptor | undefined}
 */
function createDescriptor (context, responsePath, input, fieldNode) {
  const plan = context.ddTracePlan
  const fieldsByPath = plan.fieldsByPath
  /* c8 ignore next: graphql-jit compiles every field before the plan closes. */
  if (fieldsByPath === undefined) return

  const pathKey = serializeCompilerPath(responsePath)
  let parentPath = responsePath.prev
  while (parentPath && parentPath.type !== 'literal') parentPath = parentPath.prev

  const baseTypeName = getBaseTypeName(input.returnType)
  const collapsedPath = getCollapsedPath(responsePath)
  const descriptor = {
    id: plan.fields.length,
    arguments: input.arguments ?? [],
    baseTypeName,
    collapsedPath,
    fieldName: input.fieldName,
    fieldNode,
    parentPathKey: parentPath ? serializeCompilerPath(parentPath) : undefined,
    parentTypeName: input.parentType.name,
    pathDepth: getPathDepth(responsePath, true),
    resource: `${input.fieldName}:${input.returnType}`,
    returnType: input.returnType,
    selectionDepth: getPathDepth(responsePath, false),
    tags: {
      'graphql.field.coordinates': `${input.parentType.name}.${input.fieldName}`,
      'graphql.field.name': input.fieldName,
      'graphql.field.path': collapsedPath,
      'graphql.field.type': baseTypeName,
    },
  }

  plan.fields.push(descriptor)
  fieldsByPath.set(pathKey, descriptor)
  return descriptor
}

/**
 * @param {CompilerPath | undefined} path
 * @returns {string}
 */
function serializeCompilerPath (path) {
  let key = ''
  for (let current = path; current; current = current.prev) {
    key = `${current.type}:${current.key}/${key}`
  }
  return key
}

/**
 * @param {CompilerPath | undefined} path
 * @returns {string}
 */
function getRuntimePath (path) {
  const segments = []
  for (let current = path; current; current = current.prev) {
    if (current.type === 'literal') {
      segments.push(JSON.stringify(current.key))
    } else if (current.type === 'variable') {
      segments.push(current.key)
    }
  }
  segments.reverse()
  return `[${segments.join(',')}]`
}

/**
 * @param {CompilerPath | undefined} path
 * @returns {string}
 */
function getCollapsedPath (path) {
  const segments = []
  for (let current = path; current; current = current.prev) {
    if (current.type === 'literal') {
      segments.push(current.key)
    } else if (current.type === 'variable') {
      segments.push('*')
    }
  }
  segments.reverse()
  return segments.join('.')
}

/**
 * @param {CompilerPath | undefined} path
 * @param {boolean} countListIndices
 * @returns {number}
 */
function getPathDepth (path, countListIndices) {
  let depth = 0
  for (let current = path; current; current = current.prev) {
    if (current.type === 'literal' || (countListIndices && current.type === 'variable')) depth++
  }
  return depth
}

/**
 * @param {import('graphql').GraphQLOutputType} type
 * @returns {string | undefined}
 */
function getBaseTypeName (type) {
  let current = type
  while ('ofType' in current) current = current.ofType
  return current.name
}

module.exports = GraphQLJitExecutePlugin
