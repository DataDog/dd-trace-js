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
 *   parentType: import('graphql').GraphQLCompositeType
 * }} DescriptorInput
 * @typedef {{
 *   key: string,
 *   prev?: ArgumentPath
 * }} ArgumentPath
 * @typedef {{
 *   missing: { path: ArgumentPath, valueNode: { name: { value: string } } }[],
 *   values: Record<string, unknown>
 * }} CompiledArguments
 * @typedef {{
 *   baseTypeName: string,
 *   resource: string,
 *   tags: Record<string, string | undefined>
 * }} FieldMetadata
 * @typedef {{
 *   id: number,
 *   baseTypeName: string,
 *   collapsedPath: string,
 *   collapsedPathSegments: string[],
 *   staticArguments?: Record<string, unknown>,
 *   hasArgumentVariables?: boolean,
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
 *   hoistedFunctions: string[],
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
 *   variableValues: Record<string, unknown> | undefined,
 *   cloneValue?: (value: unknown) => unknown
 * ) => Record<string, unknown>} ArgumentFactory
 * @typedef {(
 *   rootCtx: object,
 *   descriptorId: number,
 *   source: Record<string, unknown>,
 *   path: (string | number)[] | undefined,
 *   argumentFactory: ArgumentFactory | undefined
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
 *     args: CompiledArguments,
 *     argumentSource: string,
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
  const runtime = {
    compileDefaultField,
    finalizeCompilation,
    registerField,
    resolveDefaultInvocation,
    startExecution,
  }

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
   * @param {CompiledArguments} args
   * @param {string} argumentSource
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
    args,
    argumentSource,
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
    descriptor.staticArguments = args.values
    descriptor.hasArgumentVariables = args.missing.length !== 0
    const argumentFactory = compileArgumentFactory(context, descriptor, args.missing, argumentSource)

    const shouldTrace = '__context.ddTrace !== undefined && ' +
      '(__context.ddTrace.jitTraceAll || ' +
      `(__context.ddTrace.jitTraceFirst && __context.ddTrace.jitFields[${descriptor.id}] === undefined))`
    const resolveDefault = '__context.ddTrace.jitRuntime.resolveDefaultInvocation(' +
      `__context.ddTrace, ${descriptor.id}, ${parentPath}, ` +
      `__context.ddTrace.config.collapse ? undefined : ${compilerPath.runtimePath}, ${argumentFactory})`
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
    baseTypeName,
    collapsedPath: compilerPath.collapsedPath,
    collapsedPathSegments: compilerPath.collapsedPathSegments,
    fieldName: input.fieldName,
    fieldNode,
    fieldNodes: input.fieldNodes,
    hasArgumentVariables: undefined,
    parentId: undefined,
    parentPathKey: compilerPath.parentPathKey,
    parentTypeName,
    pathDepth: compilerPath.pathDepth,
    resource,
    returnType: input.returnType,
    selectionDepth: compilerPath.selectionDepth,
    staticArguments: undefined,
    tags,
  }

  plan.fields.push(descriptor)
  plan.fieldsByPath.set(compilerPath.pathKey, descriptor)
  return descriptor
}

/**
 * @param {ConfiguredJitCompilationContext} context
 * @param {JitFieldDescriptor} descriptor
 * @param {CompiledArguments['missing']} missing
 * @param {string} argumentSource
 * @returns {string}
 */
function compileArgumentFactory (context, descriptor, missing, argumentSource) {
  if (missing.length === 0 && Object.keys(descriptor.staticArguments).length === 0) return 'undefined'

  const name = `ddTraceArguments${descriptor.id}`
  let source = `function ${name} (variableValues, cloneValue) {\n  const args = ${argumentSource}\n`
  const pathsByVariable = new Map()

  for (const { path, valueNode } of missing) {
    const variableName = valueNode.name.value
    let paths = pathsByVariable.get(variableName)
    if (paths === undefined) {
      paths = []
      pathsByVariable.set(variableName, paths)
    }
    paths.push(path)
  }

  let variableIndex = 0
  for (const [variableName, paths] of pathsByVariable) {
    const variableSource = `ddTraceVariable${variableIndex++}`
    const quotedName = quoteString(variableName)
    source += `  if (variableValues !== undefined && Object.hasOwn(variableValues, ${quotedName})) {
    const ${variableSource} = cloneValue === undefined
      ? variableValues[${quotedName}]
      : cloneValue(variableValues[${quotedName}])
`
    for (const path of paths) {
      source += `    ${compileArgumentPath(path)} = ${variableSource}\n`
    }
    source += '  }\n'
  }

  source += '  return args\n}\n'
  context.hoistedFunctions.push(source)
  return name
}

/**
 * @param {ArgumentPath} path
 * @returns {string}
 */
function compileArgumentPath (path) {
  let source = 'args'
  for (let current = path; current !== undefined; current = current.prev) {
    source += `[${quoteString(current.key)}]`
  }
  return source
}

/**
 * @param {string} value
 * @returns {string}
 */
function quoteString (value) {
  const json = JSON.stringify(value)
  const content = json.slice(1, -1)
    .replaceAll("'", String.raw`\'`)
    .replaceAll(String.raw`\"`, '"')
  return `'${content}'`
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
  let lastLiteralPathKey
  let parentPathKey
  let pathDepth = 0
  let pathKey = ''
  let runtimePath = '['
  let selectionDepth = 0
  for (let index = segments.length - 1; index >= 0; index--) {
    const { key, type } = segments[index]
    pathKey += `${type}:${key}/`
    if (type === 'meta') continue

    if (pathDepth !== 0) {
      runtimePath += ', '
    }

    if (type === 'literal') {
      collapsedPathSegments.push(key)
      parentPathKey = lastLiteralPathKey
      lastLiteralPathKey = pathKey
      runtimePath += `'${key}'`
      selectionDepth++
    } else {
      collapsedPathSegments.push('*')
      runtimePath += key
    }
    pathDepth++
  }
  runtimePath += ']'

  return {
    collapsedPath: collapsedPathSegments.join('.'),
    collapsedPathSegments,
    parentPathKey,
    pathDepth,
    pathKey,
    runtimePath,
    selectionDepth,
  }
}

module.exports = createGraphqlJitRuntime
