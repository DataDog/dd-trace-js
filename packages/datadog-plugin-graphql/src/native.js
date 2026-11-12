'use strict'

// GraphQL 17 publishes `graphql:*` tracing channels on every Node.js version and module format, so these
// plugins map their contexts onto the arguments the rewriter channels carry for earlier versions.

const dc = require('dc-polyfill')

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const GraphQLExecutePlugin = require('./execute')
const GraphQLParsePlugin = require('./parse')
const { recordResolveError } = require('./resolve-error')
const GraphQLValidatePlugin = require('./validate')
const { getOperation } = require('./utils')

const {
  PENDING_FIELD_END_TIME,
  REUSED_FIELD_END_TIME,
  addField,
  createResolverInfo,
  findCollapsedField,
} = GraphQLExecutePlugin

const legacyStorage = storage('legacy')

const iastResolveCh = dc.channel('apm:graphql:resolve:start')
const resolverStartCh = dc.channel('datadog:graphql:resolver:start')

/**
 * The entry of the last GraphQL 17 module loaded. It re-exports the `print`, `visit` and `getOperationAST` that
 * the signature tools need when a require() of its ES module build hides the files that define them.
 *
 * @type {object | undefined}
 */
let graphqlEntry

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

  constructor (...args) {
    super(...args)
    this.addSub('apm:graphql:entry:load', ({ graphql }) => { graphqlEntry = graphql })
  }

  bindStart (ctx) {
    const { schema, document, operationName } = ctx
    ctx.arguments = [{ schema, document, variableValues: ctx.rawVariableValues, operationName }]
    const store = super.bindStart(ctx)

    const rootCtx = ctx.ddRootCtx
    if (rootCtx) {
      rootCtx.native = true
      rootCtx.document = document
      rootCtx.operation = getOperation(document, operationName)
    }
    return store
  }

  // The resolve plugin traces every field from GraphQL's resolve channel, so the schema stays untouched.
  wrapExecutionResolvers (ctx, args) {
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

/**
 * GraphQL 17 publishes every field resolution on its resolve channel. The context carries the field name, parent
 * type, return type, arguments and dotted path, but not the resolve info, so the field node comes from the
 * operation and the parent field from the path.
 */
class GraphQLNativeResolvePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'resolve'
  static prefix = 'tracing:graphql:resolve'

  bindStart (ctx) {
    return startField(ctx)
  }

  end (ctx) {
    if (isSettled(ctx)) finishField(ctx)
  }

  asyncEnd (ctx) {
    finishField(ctx)
  }

  error (ctx) {
    ctx.ddFailed = true
    // Like locatedError(), an error that already carries a path belongs to that path.
    if (ctx.ddReusedField && !Array.isArray(ctx.error?.path)) recordResolveError(ctx.ddReusedField, ctx.error)
  }
}

/**
 * @param {object} ctx `graphql:resolve` context
 * @returns {object | undefined} The store the resolver runs in.
 */
function startField (ctx) {
  const store = legacyStorage.getStore()
  const rootCtx = store?.graphqlRootCtx
  if (!rootCtx?.native) return store

  const hasIastSub = iastResolveCh.hasSubscribers
  const hasResolverSub = resolverStartCh.hasSubscribers
  if (rootCtx.depthDisabled && !hasIastSub && !hasResolverSub) return store

  const config = rootCtx.config
  const segments = ctx.fieldPath.split('.')
  const args = ctx.args
  const fieldNode = config.source || config.variables || hasResolverSub
    ? findFieldNode(rootCtx, segments)
    : undefined

  // IAST and AppSec see every field, regardless of depth or collapse.
  if (hasIastSub) {
    iastResolveCh.publish({ rootCtx, args })
  }
  if (hasResolverSub) {
    resolverStartCh.publish({
      abortController: rootCtx.abortController,
      createResolverInfo,
      info: { fieldName: ctx.fieldName, fieldNodes: fieldNode && [fieldNode] },
      args,
    })
  }

  if (rootCtx.depthDisabled || !shouldInstrumentSegments(config, segments)) return store

  const pathString = toPathString(segments, segments.length, config.collapse)
  const collapsedField = rootCtx.fields.get(pathString)
  let field = findCollapsedField(rootCtx, collapsedField, ctx.parentType)
  if (field !== undefined) {
    field.endTime = REUSED_FIELD_END_TIME
    rootCtx.lastFields?.set(pathString, field)
    ctx.ddReusedField = field
    return field.currentStore
  }

  const fieldType = ctx.fieldType
  field = {
    fieldNode,
    fieldName: ctx.fieldName,
    parentTypeName: ctx.parentType,
    returnType: fieldType,
    baseTypeName: fieldType.replaceAll(/[[\]!]/g, ''),
    endTime: PENDING_FIELD_END_TIME,
    infoPath: undefined,
    jitPathKey: false,
    pathString,
    collapsedKey: pathString,
    span: null,
    parentStore: null,
    currentStore: null,
  }
  addField(rootCtx, pathString, field, collapsedField)
  // Under collapse, list items of different types share a path, so children parent to the latest field there.
  if (config.collapse) {
    rootCtx.lastFields ??= new Map()
    rootCtx.lastFields.set(pathString, field)
  }

  const executeSpan = rootCtx.executeSpan
  rootCtx.plugin.startResolveSpan(field, rootCtx, executeSpan, executeSpan._getTime(), rootCtx.variableValues,
    findParentField(rootCtx, segments))
  ctx.ddField = field
  ctx.ddRootCtx = rootCtx
  return field.currentStore
}

/**
 * @param {object} ctx `graphql:resolve` context
 */
function finishField (ctx) {
  const field = ctx.ddField
  if (field === undefined) return
  ctx.ddField = undefined
  ctx.ddRootCtx.plugin?.completeResolveSpan(ctx.ddRootCtx, field, ctx.error, ctx.result, ctx.ddFailed === true)
}

/**
 * GraphQL publishes `end` with the result of a synchronous call, and on `asyncEnd` for a promise.
 *
 * @param {{ result?: unknown, ddFailed?: boolean }} ctx
 */
function isSettled (ctx) {
  return ctx.ddFailed === true || Object.hasOwn(ctx, 'result')
}

/**
 * @param {object} rootCtx
 * @param {string[]} segments
 * @returns {object | null}
 */
function findParentField (rootCtx, segments) {
  for (let end = segments.length - 1; end > 0; end--) {
    if (isListIndex(segments[end - 1])) continue
    const pathString = toPathString(segments, end, rootCtx.config.collapse)
    const field = rootCtx.lastFields?.get(pathString) ?? rootCtx.fields.get(pathString)
    if (field) return field
  }
  return null
}

/**
 * @param {object} rootCtx
 * @param {string[]} segments
 * @returns {import('graphql').FieldNode | undefined}
 */
function findFieldNode (rootCtx, segments) {
  if (rootCtx.fragments === undefined) {
    rootCtx.fragments = new Map()
    for (const definition of rootCtx.document.definitions) {
      if (definition.kind === 'FragmentDefinition') rootCtx.fragments.set(definition.name.value, definition)
    }
  }

  let selectionSets = [rootCtx.operation?.selectionSet]
  let fieldNode
  for (const segment of segments) {
    if (isListIndex(segment)) continue
    const fieldNodes = []
    for (const selectionSet of selectionSets) collectFieldNodes(rootCtx, selectionSet, segment, fieldNodes)
    fieldNode = fieldNodes[0]
    if (fieldNode === undefined) return
    selectionSets = fieldNodes.map(node => node.selectionSet)
  }
  return fieldNode
}

/**
 * @param {object} rootCtx
 * @param {import('graphql').SelectionSetNode | undefined} selectionSet
 * @param {string} responseKey
 * @param {import('graphql').FieldNode[]} fieldNodes
 */
function collectFieldNodes (rootCtx, selectionSet, responseKey, fieldNodes) {
  if (selectionSet === undefined) return
  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      if ((selection.alias ?? selection.name).value === responseKey) fieldNodes.push(selection)
    } else {
      const fragment = selection.kind === 'FragmentSpread'
        ? rootCtx.fragments.get(selection.name.value)
        : selection
      collectFieldNodes(rootCtx, fragment?.selectionSet, responseKey, fieldNodes)
    }
  }
}

/**
 * @param {string} segment
 */
function isListIndex (segment) {
  const code = segment.charCodeAt(0)
  return code >= 48 && code <= 57
}

/**
 * @param {string[]} segments
 * @param {number} end
 * @param {boolean} collapse
 */
function toPathString (segments, end, collapse) {
  let pathString = ''
  for (let i = 0; i < end; i++) {
    const segment = collapse && isListIndex(segments[i]) ? '*' : segments[i]
    pathString = i === 0 ? segment : `${pathString}.${segment}`
  }
  return pathString
}

/**
 * The dotted-path form of the execute plugin's depth check.
 *
 * @param {{ depth: number, countListIndices?: boolean }} config
 * @param {string[]} segments
 */
function shouldInstrumentSegments (config, segments) {
  if (config.depth < 0) return true

  let depth = 0
  for (const segment of segments) {
    if (config.countListIndices || !isListIndex(segment)) depth++
  }
  return config.depth >= depth
}

module.exports = {
  GraphQLNativeExecutePlugin,
  GraphQLNativeParsePlugin,
  GraphQLNativeResolvePlugin,
  GraphQLNativeValidatePlugin,
  getGraphqlEntry: () => graphqlEntry,
}
