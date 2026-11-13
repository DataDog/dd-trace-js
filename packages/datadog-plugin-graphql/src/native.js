'use strict'

// GraphQL 17 publishes `graphql:*` tracing channels in either module format wherever `process.getBuiltinModule`
// exists, so these plugins map their contexts onto the arguments the rewriter channels carry elsewhere.

const dc = require('dc-polyfill')

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const GraphQLExecutePlugin = require('./execute')
const GraphQLParsePlugin = require('./parse')
const { recordResolveError, recordResolveErrorForPath } = require('./resolve-error')
const GraphQLValidatePlugin = require('./validate')
const { getOperation } = require('./utils')

const {
  PENDING_FIELD_END_TIME,
  REUSED_FIELD_END_TIME,
  addField,
  createResolverInfo,
  findCollapsedField,
  wrapFields,
} = GraphQLExecutePlugin

const legacyStorage = storage('legacy')

const iastResolveCh = dc.channel('apm:graphql:resolve:start')
const resolverStartCh = dc.channel('datadog:graphql:resolver:start')

/** Errors the resolve channel already attributed to their field. */
const resolveErrors = new WeakSet()

/**
 * The entry of the last GraphQL 17 module loaded. It re-exports the `print`, `visit` and `getOperationAST` that
 * the signature tools need when a require() of its ES module build hides the files that define them.
 *
 * @type {object | undefined}
 */
let graphqlEntry
dc.subscribe('apm:graphql:entry:load', ({ graphql }) => { graphqlEntry = graphql })

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
    const { schema, document } = ctx
    // The `operationName` getter resolves the operation and throws on a malformed document.
    const operationName = Array.isArray(document?.definitions) ? ctx.operationName : undefined
    ctx.arguments = [{ schema, document, variableValues: ctx.rawVariableValues, operationName }]
    const store = super.bindStart(ctx)

    const rootCtx = ctx.ddRootCtx
    if (rootCtx) {
      rootCtx.native = true
      rootCtx.document = document
      rootCtx.operation = getOperation(document, operationName)
      if (this.config.hooks.execute) rootCtx.hookArgs = ctx.ddArgs
    }
    return store
  }

  // The schema wrapper traces the fields with their own resolver, as on other versions. The execute channel does not
  // expose a `fieldResolver` to wrap, so the resolve plugin traces the fields left to GraphQL's default resolver.
  wrapExecutionResolvers (ctx, args) {
    ctx.ddArgs = args
    const { schema } = args
    if (schema) {
      wrapFields(schema.getQueryType(), schema)
      wrapFields(schema.getMutationType(), schema)
      wrapFields(schema.getSubscriptionType(), schema)
    }
  }

  // A promise result is published on asyncEnd.
  end (ctx) {
    if (isSettled(ctx)) this.#finish(ctx)
  }

  asyncEnd (ctx) {
    this.#finish(ctx)
  }

  #finish (ctx) {
    // Errors raised while completing a field, such as a null non-null value, never reach the resolve channel.
    const errors = ctx.ddRootCtx && ctx.result?.errors
    if (Array.isArray(errors)) {
      for (const error of errors) {
        const originalError = error.originalError ?? error
        if (Array.isArray(error.path) && !resolveErrors.has(originalError)) {
          recordResolveErrorForPath(originalError, error.path, undefined, ctx.ddRootCtx)
        }
      }
    }
    super.end(ctx)
  }

  error (ctx) {
    ctx.ddFailed = true
    super.error(ctx)
  }
}

/**
 * GraphQL 17 publishes every field resolution on its resolve channel. This plugin traces the fields that use the
 * default resolver, which the schema wrapper cannot reach. The context carries the field name, parent type, return
 * type, arguments and dotted path, but not the resolve info, so the field node comes from the operation and the
 * parent field from the path. Binding a store to the channel would run for every field, so the plugin enters the
 * field's store only around the fields it traces, for a resolver function on the root value or source object.
 */
class GraphQLNativeResolvePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'resolve'
  static prefix = 'tracing:graphql:resolve'

  start (ctx) {
    startField(ctx)
  }

  end (ctx) {
    if (ctx.ddParentStore !== undefined) legacyStorage.enterWith(ctx.ddParentStore)
    if (isSettled(ctx)) finishField(ctx)
  }

  asyncEnd (ctx) {
    finishField(ctx)
  }

  // The rewriter's locatedError() hook is absent here, so this records the errors of collapsed fields the resolver
  // of an earlier list item already traced, including those the schema wrapper traced.
  error (ctx) {
    ctx.ddFailed = true
    const error = ctx.error
    if (ctx.ddField !== undefined) {
      markRecorded(error)
      return
    }
    // Like locatedError(), an error that already carries a path belongs to that path.
    if (Array.isArray(error?.path)) return
    const field = ctx.ddReusedField ?? findTracedField(ctx)
    if (field?.span) {
      recordResolveError(field, error)
      markRecorded(error)
    }
  }
}

/**
 * @param {object} ctx `graphql:resolve` context
 */
function startField (ctx) {
  if (!ctx.isDefaultResolver) return
  const store = legacyStorage.getStore()
  const rootCtx = store?.graphqlRootCtx
  if (!rootCtx?.native) return

  const hasIastSub = iastResolveCh.hasSubscribers
  const hasResolverSub = rootCtx.hasResolverSub
  if (rootCtx.depthDisabled && !hasIastSub && !hasResolverSub) return

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

  if (rootCtx.depthDisabled || !shouldInstrumentSegments(config, segments)) return

  const pathString = toPathString(segments, segments.length, config.collapse)
  const collapsedField = rootCtx.fields.get(pathString)
  let field = findCollapsedField(rootCtx, collapsedField, ctx.parentType)
  if (field !== undefined) {
    field.endTime = REUSED_FIELD_END_TIME
    rootCtx.lastFields?.set(pathString, field)
    ctx.ddReusedField = field
    enterFieldStore(ctx, store, field)
    return
  }

  const fieldType = ctx.fieldType
  // Same shape and key order as the field `wrapResolve()` builds in execute.js.
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
  enterFieldStore(ctx, store, field)
}

/**
 * @param {unknown} error
 */
function markRecorded (error) {
  if (typeof error === 'object' && error !== null) resolveErrors.add(error)
}

/**
 * @param {object} ctx `graphql:resolve` context of a field with its own resolver
 * @returns {object | undefined} The field the schema wrapper traced for the path and parent type.
 */
function findTracedField (ctx) {
  const rootCtx = legacyStorage.getStore()?.graphqlRootCtx
  if (!rootCtx?.native || rootCtx.depthDisabled) return

  const config = rootCtx.config
  const segments = ctx.fieldPath.split('.')
  if (!shouldInstrumentSegments(config, segments)) return
  const field = rootCtx.fields.get(toPathString(segments, segments.length, config.collapse))
  return findCollapsedField(rootCtx, field, ctx.parentType)
}

/**
 * GraphQL publishes `end` synchronously once the resolver returns, which restores the parent store.
 *
 * @param {object} ctx `graphql:resolve` context
 * @param {object} parentStore
 * @param {object} field
 */
function enterFieldStore (ctx, parentStore, field) {
  ctx.ddParentStore = parentStore
  legacyStorage.enterWith(field.currentStore)
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
 * GraphQL publishes `end` with the result of a synchronous call, and on `asyncEnd` for a promise. Its context only
 * gains `result` once the call settles, so a pending promise leaves it absent on `end`.
 *
 * @param {{ result?: unknown, ddFailed?: boolean }} ctx
 */
function isSettled (ctx) {
  return ctx.ddFailed === true || Object.hasOwn(ctx, 'result')
}

/**
 * The dotted-path form of the execute plugin's `getParentField()`.
 *
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
 * The dotted-path form of the execute plugin's `buildCachedPathString()`.
 *
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
 * The dotted-path form of the execute plugin's `shouldInstrumentNode()`.
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
