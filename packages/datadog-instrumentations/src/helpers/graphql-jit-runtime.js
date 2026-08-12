'use strict'

/**
 * @typedef {{
 *   collapsedPath: string,
 *   collapsedPathSegments: string[],
 *   parentPathKey: string | undefined,
 *   pathDepth: number,
 *   pathKey: string,
 *   runtimePath: string,
 *   selectionDepth: number
 * }} CompilerPathAnalysis
 * @typedef {{
 *   fieldName: string,
 *   fieldNodes: [import('graphql').FieldNode, ...import('graphql').FieldNode[]],
 *   returnType: import('graphql').GraphQLOutputType,
 *   parentType: import('graphql').GraphQLCompositeType,
 *   arguments?: import('graphql').GraphQLArgument[]
 * }} DescriptorInput
 * @typedef {{
 *   fixed: Record<string, unknown>,
 *   variables: string[] | undefined,
 *   dynamic: import('graphql').ArgumentNode[] | undefined
 * }} ArgumentTemplate
 * @typedef {{
 *   baseTypeName: string,
 *   resource: string,
 *   tags: Record<string, string | undefined>
 * }} FieldMetadata
 * @typedef {{
 *   id: number,
 *   arguments: import('graphql').GraphQLArgument[],
 *   argumentTemplate?: ArgumentTemplate,
 *   baseTypeName: string,
 *   collapsedPath: string,
 *   collapsedPathSegments: string[],
 *   fieldName: string,
 *   fieldNode: import('graphql').FieldNode,
 *   fieldNodes: [import('graphql').FieldNode, ...import('graphql').FieldNode[]],
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
 *   fieldsByPath: Map<string, JitFieldDescriptor>
 * }} BuildingJitPlan
 * @typedef {{ fields: JitFieldDescriptor[] }} JitPlan
 * @typedef {Record<string, import('graphql').GraphQLFieldResolver<unknown, unknown>>} GraphQLResolverMap
 * @typedef {{
 *   ddTraceDefaultResolvers?: boolean,
 *   ddTracePlan?: BuildingJitPlan,
 *   ddTraceRuntime?: GraphqlJitRuntime,
 *   resolvers: GraphQLResolverMap
 * }} JitCompilationContext
 * @typedef {JitCompilationContext & { ddTracePlan: BuildingJitPlan }} ConfiguredJitCompilationContext
 * @typedef {(
 *   parentTypeName: string,
 *   fieldName: string,
 *   returnType: import('graphql').GraphQLOutputType,
 *   collapsedPath: string
 * ) => FieldMetadata} CreateFieldMetadata
 * @typedef {(
 *   rootCtx: object,
 *   descriptorId: number,
 *   source: Record<string, unknown>,
 *   path: (string | number)[] | undefined
 * ) => unknown} ResolveDefaultInvocation
 * @typedef {(variableValues: Record<string, unknown> | undefined) => object | undefined} StartExecution
 * @typedef {(
 *   resolver: import('graphql').GraphQLFieldResolver<unknown, unknown>
 * ) => import('graphql').GraphQLFieldResolver<unknown, unknown>} WrapResolver
 * @typedef {{
 *   createFieldMetadata: CreateFieldMetadata,
 *   resolveDefaultInvocation: ResolveDefaultInvocation,
 *   startExecution: StartExecution,
 *   wrapResolver: WrapResolver
 * }} GraphqlJitRuntimeOptions
 * @typedef {{
 *   compileDefaultField: (
 *     context: ConfiguredJitCompilationContext,
 *     responsePath: unknown,
 *     parentType: import('graphql').GraphQLCompositeType,
 *     field: {
 *       name: string,
 *       type: import('graphql').GraphQLOutputType,
 *       args: import('graphql').GraphQLArgument[]
 *     },
 *     fieldNodes: [import('graphql').FieldNode, ...import('graphql').FieldNode[]],
 *     originPaths: string[],
 *     compiledField: string
 *   ) => string,
 *   finalizeCompilation: (
 *     context: JitCompilationContext & { ddTracePlan: BuildingJitPlan }
 *   ) => JitPlan,
 *   registerField: (
 *     context: ConfiguredJitCompilationContext,
 *     responsePath: unknown,
 *     input: DescriptorInput
 *   ) => number | undefined,
 *   resolveDefaultInvocation: ResolveDefaultInvocation,
 *   startExecution: StartExecution
 * }} GraphqlJitRuntime
 */

/**
 * @param {GraphqlJitRuntimeOptions} options
 * @returns {{
 *   configureCompilationContext: (message: { result?: JitCompilationContext }) => void,
 *   runtime: GraphqlJitRuntime
 * }}
 */
function createGraphqlJitRuntime ({
  createFieldMetadata,
  resolveDefaultInvocation,
  startExecution,
  wrapResolver,
}) {
  const runtime = Object.freeze({
    compileDefaultField,
    finalizeCompilation,
    registerField,
    resolveDefaultInvocation,
    startExecution,
  })

  /**
   * @param {{ result?: JitCompilationContext }} message
   */
  function configureCompilationContext ({ result: context }) {
    if (!context) return

    context.ddTraceDefaultResolvers = true
    context.ddTraceRuntime = runtime
    context.ddTracePlan = {
      fields: [],
      fieldsByPath: new Map(),
    }
  }

  /**
   * @param {ConfiguredJitCompilationContext} context
   * @param {unknown} responsePath
   * @param {DescriptorInput} input
   * @returns {number | undefined}
   */
  function registerField (context, responsePath, input) {
    const [fieldNode] = input.fieldNodes
    const compilerPath = analyzeCompilerPath(responsePath)
    /* istanbul ignore next: a future graphql-jit version may change its private response-path shape. */
    if (compilerPath === undefined) return

    return createDescriptor(context, compilerPath, input, fieldNode, createFieldMetadata).id
  }

  /**
   * @param {JitCompilationContext & { ddTracePlan: BuildingJitPlan }} context
   * @returns {JitPlan}
   */
  function finalizeCompilation (context) {
    const plan = context.ddTracePlan

    for (const field of plan.fields) {
      if (field.parentPathKey !== undefined) {
        field.parentId = plan.fieldsByPath.get(field.parentPathKey)?.id
        field.parentPathKey = undefined
      }
    }
    for (const name of Object.keys(context.resolvers)) {
      context.resolvers[name] = wrapResolver(context.resolvers[name])
    }

    return {
      fields: plan.fields,
    }
  }

  /**
   * @param {ConfiguredJitCompilationContext} context
   * @param {unknown} responsePath
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
    const parentPath = originPaths.join('.')
    const sourcePath = `${parentPath}.${field.name}`
    const sourceIndex = compiledField.indexOf(sourcePath)
    /* istanbul ignore next: a future compiler may stop emitting the source path in its completion expression. */
    if (sourceIndex === -1) return compiledField

    const compilerPath = analyzeCompilerPath(responsePath)
    /* istanbul ignore next: a future graphql-jit version may change its private response-path shape. */
    if (compilerPath === undefined) return compiledField

    const descriptor = createDescriptor(context, compilerPath, {
      arguments: field.args,
      fieldName: field.name,
      fieldNodes,
      returnType: field.type,
      parentType,
    }, fieldNodes[0], createFieldMetadata)

    const shouldTrace = '__context.ddTrace !== undefined && ' +
      '(__context.ddTrace.jitTraceAll || ' +
      `(__context.ddTrace.jitTraceFirst && __context.ddTrace.jitFields[${descriptor.id}] === undefined))`
    const resolveDefault = '__context.ddTrace.jitRuntime.resolveDefaultInvocation(' +
      `__context.ddTrace, ${descriptor.id}, ${parentPath}, ` +
      `__context.ddTrace.config.collapse ? undefined : ${compilerPath.runtimePath})`
    const tracedRead = `(${shouldTrace} ? ${resolveDefault} : ${sourcePath})`

    return compiledField.slice(0, sourceIndex) + tracedRead + compiledField.slice(sourceIndex + sourcePath.length)
  }

  return { configureCompilationContext, runtime }
}

/**
 * @param {ConfiguredJitCompilationContext} context
 * @param {CompilerPathAnalysis} compilerPath
 * @param {DescriptorInput} input
 * @param {import('graphql').FieldNode} fieldNode
 * @param {CreateFieldMetadata} createFieldMetadata
 * @returns {JitFieldDescriptor}
 */
function createDescriptor (context, compilerPath, input, fieldNode, createFieldMetadata) {
  const plan = context.ddTracePlan

  const parentTypeName = input.parentType.name
  const { baseTypeName, resource, tags } = createFieldMetadata(
    parentTypeName,
    input.fieldName,
    input.returnType,
    compilerPath.collapsedPath
  )
  const descriptor = {
    id: plan.fields.length,
    arguments: input.arguments ?? [],
    argumentTemplate: undefined,
    baseTypeName,
    collapsedPath: compilerPath.collapsedPath,
    collapsedPathSegments: compilerPath.collapsedPathSegments,
    fieldName: input.fieldName,
    fieldNode,
    fieldNodes: input.fieldNodes,
    parentId: undefined,
    parentPathKey: compilerPath.parentPathKey,
    parentTypeName,
    pathDepth: compilerPath.pathDepth,
    resource,
    returnType: input.returnType,
    selectionDepth: compilerPath.selectionDepth,
    tags,
  }

  plan.fields.push(descriptor)
  plan.fieldsByPath.set(compilerPath.pathKey, descriptor)
  return descriptor
}

/**
 * @param {unknown} path
 * @returns {CompilerPathAnalysis | undefined}
 */
function analyzeCompilerPath (path) {
  const segments = []
  let current = path
  while (current !== undefined) {
    /* istanbul ignore next: only a future graphql-jit path representation can exercise this fallback. */
    if (current === null || typeof current !== 'object') return

    const key = Reflect.get(current, 'key')
    const type = Reflect.get(current, 'type')
    /* istanbul ignore next: only a future graphql-jit path segment can exercise this fallback. */
    if (typeof key !== 'string' || (type !== 'literal' && type !== 'meta' && type !== 'variable')) return

    segments.push({ key, type })
    current = Reflect.get(current, 'prev')
  }

  const collapsedPathSegments = []
  const literalPathKeys = []
  const runtimePathSegments = []
  let pathDepth = 0
  let pathKey = ''
  let selectionDepth = 0
  for (let index = segments.length - 1; index >= 0; index--) {
    const { key, type } = segments[index]
    pathKey += `${type}:${key}/`
    if (type === 'literal') {
      collapsedPathSegments.push(key)
      literalPathKeys.push(pathKey)
      runtimePathSegments.push(`'${key}'`)
      pathDepth++
      selectionDepth++
    } else if (type === 'variable') {
      collapsedPathSegments.push('*')
      runtimePathSegments.push(key)
      pathDepth++
    }
  }

  return {
    collapsedPath: collapsedPathSegments.join('.'),
    collapsedPathSegments,
    parentPathKey: literalPathKeys.at(-2),
    pathDepth,
    pathKey,
    runtimePath: `[${runtimePathSegments.join(', ')}]`,
    selectionDepth,
  }
}

module.exports = createGraphqlJitRuntime
