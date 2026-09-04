'use strict'

const dc = require('dc-polyfill')

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const GraphQLParsePlugin = require('./parse')
const { recordResolveError } = require('./resolve-error')
const {
  extractErrorIntoSpanEvent,
  getBaseTypeName,
  getOperation,
  getSignature,
  isApolloHealthCheck,
  refineRequestSpanMetadata,
} = require('./utils')

/**
 * @typedef {import('../../dd-trace/src/opentracing/span')} DatadogSpan
 * @typedef {import('../../datadog-instrumentations/src/helpers/graphql-jit-runtime').JitFieldDescriptor} JitDescriptor
 * @typedef {import('graphql').GraphQLFieldResolver<unknown, unknown>} GraphQLFieldResolver
 * @typedef {Parameters<GraphQLFieldResolver> & { [index: number]: unknown, length: number }} ArgumentsList
 * @typedef {{
 *   schema?: import('graphql').GraphQLSchema,
 *   document?: import('graphql').DocumentNode,
 *   rootValue?: unknown,
 *   contextValue?: unknown,
 *   variableValues?: Record<string, unknown>,
 *   operationName?: string | null,
 *   fieldResolver?: GraphQLFieldResolver
 * }} ExecutionArguments
 * @typedef {(value: unknown) => unknown} ThenableCallback
 * @typedef {{ then: (onFulfilled?: ThenableCallback, onRejected?: ThenableCallback) => unknown }} Thenable
 * @typedef {import('../../datadog-instrumentations/src/helpers/graphql-jit-runtime').ArgumentFactory} ArgumentFactory
 */

const legacyStorage = storage('legacy')

const iastResolveCh = dc.channel('apm:graphql:resolve:start')
const resolverStartCh = dc.channel('datadog:graphql:resolver:start')

const contexts = new WeakMap()
const instrumentedArgs = new WeakSet()

const patchedResolvers = new WeakSet()
const jitResolvers = new WeakMap()
const originalResolvers = new WeakMap()

// Visited types per caller-owned schema. The walk reaches union members and
// interface implementations through the schema (`getTypes`/`getPossibleTypes`),
// so it differs per schema: a global guard would stop the second schema at any
// type the first already walked and leave its own implementations unwrapped.
// `patchedResolvers` keeps wrapping idempotent, so re-walking a shared type is
// safe and this set only terminates cycles.
const walkedTypes = new WeakMap()

// Module-level fast path: skip the resolver-side WeakMap lookup entirely
// when depth=0 disables resolver instrumentation.
let depthDisabled = false

// Initial key for the per-operation variables-filter cache. A unique sentinel
// so the first #filterVariables call never falsely matches, even when the
// operation's variableValues is undefined.
const NO_VARIABLES_CACHED = Symbol('noVariablesCached')

// `field.endTime` stays numeric: 0 is pending, -1 means a collapsed span was reused,
// and positive values are exact completion times. Pending and reused spans finish at the execution boundary.
const PENDING_FIELD_END_TIME = 0
const REUSED_FIELD_END_TIME = -1

let asyncDisposeSymbol = Symbol.asyncDispose
// @graphql-tools/executor uses this fallback before Node.js exposes Symbol.asyncDispose.
/* istanbul ignore if */
if (asyncDisposeSymbol === undefined) {
  asyncDisposeSymbol = Symbol.for('asyncDispose')
}

class AbortError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AbortError'
  }
}

/**
 * @param {GraphQLExecutePlugin} plugin
 * @param {DatadogSpan} executeSpan
 * @param {string | undefined} source
 * @param {AbortController | undefined} abortController
 * @param {{ fields: object[] } | undefined} jitPlan
 * @param {Record<string, unknown> | undefined} variableValues
 * @returns {object}
 */
function createRootContext (plugin, executeSpan, source, abortController, jitPlan, variableValues) {
  const hasIastSub = iastResolveCh.hasSubscribers
  const hasResolverSub = abortController !== undefined
  const traceResolvers = plugin.config.depth !== 0

  // Read by the generated gate in every inlined default field.
  const traceAll = hasIastSub || hasResolverSub ||
    (traceResolvers && !plugin.config.collapse)

  const rootCtx = {
    source,
    config: plugin.config,
    abortController,
    executeSpan,
    plugin,
    filteredVariablesKey: NO_VARIABLES_CACHED,
    filteredVariables: undefined,
    depthDisabled: !traceResolvers,
    hasIastSub,
    hasResolverSub,
    jitTraceAll: traceAll,
    jitTraceFirst: !traceAll && traceResolvers && plugin.config.collapse,
    variableValues,
  }

  if (jitPlan) {
    rootCtx.jitPlan = jitPlan
    if (traceResolvers) {
      if (plugin.config.collapse) {
        rootCtx.jitFields = new Array(jitPlan.fields.length)
      } else {
        rootCtx.jitFieldsByPath = new Map()
      }
    }
  }
  if (traceResolvers && (!jitPlan || !plugin.config.collapse)) {
    rootCtx.fields = new Map()
    rootCtx.pathCache = new Map()
  }

  return rootCtx
}

class GraphQLExecutePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'execute'
  static type = 'graphql'
  static kind = 'server'
  static prefix = 'tracing:orchestrion:graphql:apm:graphql:execute'

  // @graphql-tools/executor (used by graphql-yoga) emits on a different channel
  // prefix because the module name differs. Subscribe to both so Yoga execution
  // produces graphql.execute spans.
  static extraPrefixes = [
    'tracing:orchestrion:@graphql-tools/executor:apm:graphql:execute',
  ]

  /**
   * @param {{ depth?: number }} config
   */
  configure (config) {
    super.configure(config)
    depthDisabled = config.depth === 0
  }

  addTraceSubs () {
    super.addTraceSubs()

    for (const prefix of this.constructor.extraPrefixes) {
      const events = ['start', 'end', 'asyncStart', 'asyncEnd', 'error', 'finish']

      for (const event of events) {
        const bindName = `bind${event.charAt(0).toUpperCase()}${event.slice(1)}`

        if (this[event]) {
          this.addSub(`${prefix}:${event}`, message => {
            this[event](message)
          })
        }

        if (this[bindName]) {
          this.addBind(`${prefix}:${event}`, message => this[bindName](message))
        }
      }
    }
  }

  /**
   * @param {object} ctx
   * @returns {ExecutionArguments | undefined}
   */
  readExecutionArgs (ctx) {
    const rawArgs = ctx.arguments
    const args = readArgs(rawArgs, isObjectForm(rawArgs))

    // Re-entrant execute() short-circuit (yoga's normalizedExecutor calls
    // execute internally with the same arguments object — without this we'd
    // double-span). The contextValue check catches object contexts; the args
    // check also catches primitive contexts.
    if (instrumentedArgs.has(rawArgs?.[0])) {
      ctx.ddSkipped = true
      ctx.currentStore = legacyStorage.getStore()
      return
    }

    const { contextValue } = args
    if (contextValue && typeof contextValue === 'object' && contexts.has(contextValue)) {
      ctx.ddSkipped = true
      return
    }

    return args
  }

  /**
   * @param {object} ctx
   * @param {ExecutionArguments} args
   */
  wrapExecutionResolvers (ctx, args) {
    const rawArgs = ctx.arguments
    ctx.ddArgs = setWrappedFieldResolver(rawArgs, args, isObjectForm(rawArgs), defaultFieldResolver)
    if (ctx.ddArgs && typeof ctx.ddArgs === 'object') {
      instrumentedArgs.add(ctx.ddArgs)
      ctx.ddInstrumentedArgs = ctx.ddArgs
    }

    const { schema } = args
    if (schema) {
      wrapFields(schema._queryType, schema)
      wrapFields(schema._mutationType, schema)
      wrapFields(schema._subscriptionType, schema)
    }
  }

  /**
   * @param {object} ctx
   * @param {unknown} contextValue
   * @param {object} rootCtx
   */
  storeRootContext (ctx, contextValue, rootCtx) {
    if (isWeakMapKey(contextValue)) {
      contexts.set(contextValue, rootCtx)
      ctx.ddContextValue = contextValue
    } else {
      ctx.currentStore.graphqlRootCtx = rootCtx
    }
  }

  /**
   * @param {object} ctx
   */
  bindStart (ctx) {
    const args = this.readExecutionArgs(ctx)
    if (!args) return ctx.currentStore

    const { contextValue } = args
    const document = args.document
    const docSource = document ? GraphQLParsePlugin.documentSources.get(document) : undefined
    const operation = getOperation(document, args.operationName)

    const type = operation?.operation
    const name = operation?.name?.value ?? args.operationName ?? undefined
    let signature = name ?? ''
    const source = this.config.source && docSource

    // Apollo Server may execute a cached document without parsing it first.
    // Match the full gateway operation here so caller-owned AST transformations
    // cannot suppress execute/resolver AppSec and IAST channels.
    if (name === '__ApolloServiceHealthCheck__' &&
        document?.definitions?.length === 1 &&
        isApolloHealthCheck(operation)) {
      ctx.ddSkipped = true
      return ctx.currentStore
    }

    const requestStore =
      /** @type {{ graphqlRequestSpan?: DatadogSpan } | undefined} */ (legacyStorage.getStore())
    if (type !== undefined) {
      signature = getSignature(
        /** @type {import('graphql').DocumentNode} */ (document),
        name,
        type,
        this.config.signature
      )
      refineRequestSpanMetadata(requestStore?.graphqlRequestSpan, signature, type, name)
    }

    ctx.collapse = this.config.collapse
    ctx.ddOperationType = type

    const span = this.startSpan(this.operationName(), {
      service: this.config.service || this.serviceName(),
      resource: signature,
      kind: this.constructor.kind,
      type: this.constructor.type,
      meta: {
        'graphql.operation.type': type,
        'graphql.operation.name': name,
        'graphql.source': source,
      },
    }, ctx)

    addVariableTags(this.config, span, args.variableValues)

    const abortController = resolverStartCh.hasSubscribers ? new AbortController() : undefined

    this.wrapExecutionResolvers(ctx, args)

    const rootCtx = createRootContext(this, span, docSource, abortController, ctx.ddPlan, args.variableValues)
    ctx.ddRootCtx = rootCtx
    this.storeRootContext(ctx, contextValue, rootCtx)

    return ctx.currentStore
  }

  end (ctx) {
    if (ctx.ddSkipped) return ctx.parentStore

    const span = ctx?.currentStore?.span || this.activeSpan
    if (!span) return

    if (ctx.ddRootCtx && legacyStorage.getStore() !== ctx.currentStore) {
      legacyStorage.enterWith(ctx.currentStore)
    }

    // Synchronous execute() throw (e.g. execute(null, doc)) — error handler
    // already tagged the span.
    if (ctx.error) {
      this.#finishSpan(ctx, span)
      return ctx.parentStore
    }

    const result = ctx.result

    if (typeof result?.then === 'function') {
      result.then(
        (res) => this.#finishSpan(ctx, span, res),
        (error) => this.#finishSpan(ctx, span, undefined, error)
      )
    } else {
      this.#finishSpan(ctx, span, result)
    }

    return ctx.parentStore
  }

  error (ctx) {
    const span = ctx?.currentStore?.span || this.activeSpan
    if (span && ctx?.error) {
      span.setTag('error', ctx.error)
    }
  }

  /**
   * @param {object} ctx
   * @param {import('../../dd-trace/src/opentracing/span')} span
   * @param {import('graphql').ExecutionResult} [res]
   * @param {unknown} [error]
   * @param {boolean} [incrementalComplete]
   * @param {boolean} [finishPendingFields]
   */
  #finishSpan (ctx, span, res, error, incrementalComplete = false, finishPendingFields = false) {
    if (!incrementalComplete && error === undefined && ctx.ddOperationType !== 'subscription') {
      const iterator = getIncrementalIterator(res)
      if (iterator) {
        tagIncrementalResult(this.config, span, res?.initialResult)
        observeIncrementalIterator(iterator, (result, iteratorError, iteratorCancelled, complete) => {
          tagIncrementalResult(this.config, span, result)
          if (complete) {
            this.#finishSpan(ctx, span, res, iteratorError, true, iteratorCancelled)
          }
        })
        return
      }
    }

    if (error !== undefined) {
      span.setTag('error', error)
    }

    if (res?.errors?.length) {
      tagExecutionErrors(this.config, span, res.errors)
    }

    if (ctx.ddContextValue) {
      contexts.delete(ctx.ddContextValue)
    }
    if (ctx.ddInstrumentedArgs) {
      instrumentedArgs.delete(ctx.ddInstrumentedArgs)
    }

    const rootCtx = ctx.ddRootCtx
    const releaseBeforeExecuteHook = rootCtx?.resolveHooksPending === true
    if (releaseBeforeExecuteHook) {
      releaseRootContext(rootCtx, finishPendingFields)
    } else if (rootCtx?.jitResolveHooksPending === true) {
      runResolveHooks(rootCtx)
    }
    this.config.hooks.execute(span, ctx.ddArgs, res)
    if (!releaseBeforeExecuteHook) releaseRootContext(rootCtx, finishPendingFields)
    span.finish()
  }

  // Public — called from wrapResolve (free function, crosses class boundary).
  // Resolve-span creation stays inline so child fields can parent immediately.
  /**
   * @param {object} field
   * @param {object} rootCtx
   * @param {DatadogSpan} executeSpan
   * @param {number} startTime
   * @param {Record<string, unknown> | undefined} variableValues
   * @param {object | null} [parentField]
   * @returns {DatadogSpan}
   */
  startResolveSpan (field, rootCtx, executeSpan, startTime, variableValues, parentField) {
    const { fieldNode, fieldName, returnType, baseTypeName, collapsedKey } = field

    const parent = parentField === undefined ? getParentField(rootCtx, field) : parentField
    const childOf = parent?.span || executeSpan

    const document = rootCtx.source
    const loc = this.config.source && document && fieldNode && fieldNode.loc
    const source = loc && document.slice(loc.start, loc.end)

    // ctx form: startSpan sets field.currentStore = { ...activeStore, span }
    // without entering it. Collapsed siblings reuse that store until execute
    // completes and finishes the shared span.
    const meta = field.tags ?? {
      'graphql.field.coordinates': `${field.parentTypeName}.${fieldName}`,
      'graphql.field.name': fieldName,
      'graphql.field.path': collapsedKey,
      'graphql.field.type': baseTypeName,
      'graphql.source': source,
    }
    const span = this.startSpan('graphql.resolve', {
      service: this.config.service,
      resource: field.resource ?? `${fieldName}:${returnType}`,
      childOf,
      type: 'graphql',
      startTime,
      meta,
    }, field)

    field.span = span
    if (rootCtx.config.collapse) {
      if (field.jitPathKey === false) {
        field.currentStore.graphqlResolveField = { field }
      }
      field.nextResolveField = rootCtx.resolveFields
      rootCtx.resolveFields = field
    }

    if (fieldNode && this.config.variables && fieldNode.arguments) {
      const variables = this.#filterVariables(rootCtx, variableValues)
      for (const arg of fieldNode.arguments) {
        if (arg.value?.name && arg.value.kind === 'Variable' && variables[arg.value.name.value]) {
          const name = arg.value.name.value
          span.setTag(`graphql.variables.${name}`, variables[name])
        }
      }
    }

    return span
  }

  // Memoize the user variables filter against the last-seen variableValues
  // object. graphql hands every resolver in one execute the same coerced
  // variableValues object, so all arg-bearing fields hit the identity fast
  // path and the filter runs once per operation. A nested execute() sharing
  // the same object contextValue reuses the outer rootCtx but carries its own
  // variableValues; comparing by identity recomputes for it (and any later
  // fields on that inner object reuse the slot), so each field's tags stay
  // correct. A single slot beats a WeakMap here: no per-operation allocation,
  // and the common single-object case is a bare `===` (see the microbenchmark
  // numbers in the commit body).
  #filterVariables (rootCtx, variableValues) {
    if (rootCtx.filteredVariablesKey === variableValues) {
      return rootCtx.filteredVariables
    }

    const filtered = this.config.variables(variableValues)
    rootCtx.filteredVariablesKey = variableValues
    rootCtx.filteredVariables = filtered
    return filtered
  }

  /**
   * @param {object} rootCtx
   * @param {object} field
   * @param {unknown} error
   * @param {unknown} result
   * @param {boolean} [failed]
   */
  completeResolveSpan (rootCtx, field, error, result, failed = false) {
    if (rootCtx.resolveFields !== undefined) {
      if (field.endTime !== REUSED_FIELD_END_TIME) {
        field.endTime = rootCtx.executeSpan._getTime()
      }
      if (field.jitPathKey === false) {
        if (failed) recordResolveError(field, error)
        if (this.config.hooks.resolve) {
          field.resolveHookContext = createResolveHookContext(field, field.error, result)
          rootCtx.resolveHooksPending = true
        }
        return
      }
      if (field.isSharedJitField) {
        if (error) recordResolveError(field, error)
        if (this.config.hooks.resolve) {
          field.resolveHookContext = createResolveHookContext(field, field.error, result)
          rootCtx.jitResolveHooksPending = true
        }
        return
      }
      this.#completeResolveSpan(field, error, result)
      return
    }

    this.#finishResolveSpan(field, error, result, rootCtx.executeSpan._getTime())
  }

  /**
   * @param {object} field
   * @param {unknown} error
   * @param {unknown} result
   * @param {number} endTime
   */
  #finishResolveSpan (field, error, result, endTime) {
    this.#completeResolveSpan(field, error, result)
    field.span.finish(endTime)
  }

  /**
   * @param {object} field
   * @param {unknown} error
   * @param {unknown} result
   */
  #completeResolveSpan (field, error, result) {
    const { span } = field
    if (error) span.setTag('error', error)

    if (this.config.hooks.resolve) {
      this.config.hooks.resolve(span, createResolveHookContext(field, error, result))
    }
  }
}

// --- resolver wrapping --------------------------------------------------------

/**
 * @param {GraphQLFieldResolver} resolve
 * @param {boolean} [isJit]
 */
function wrapResolve (resolve, isJit = false) {
  /* istanbul ignore next: future GraphQL versions may expose a non-callable resolver entry. */
  if (typeof resolve !== 'function' || (!isJit && patchedResolvers.has(resolve))) return resolve

  // Replace a schema wrapper with the execution-local JIT variant instead of nesting both.
  resolve = unwrapResolve(resolve)
  if (isJit) {
    const jitResolver = jitResolvers.get(resolve)
    if (jitResolver !== undefined) return jitResolver
  }

  function resolveAsync (source, args, contextValue, info) {
    const hasIastSub = iastResolveCh.hasSubscribers
    const hasResolverSub = resolverStartCh.hasSubscribers

    // Combined fast-path: depth=0 AND no IAST/AppSec subscriber means nothing
    // to do — skip rootCtx lookup, path walk, publish gates.
    if (depthDisabled && !hasIastSub && !hasResolverSub) {
      return invokeResolver(resolve, this, arguments, isJit)
    }

    const rootCtx = isJit
      ? legacyStorage.getStore()?.graphqlRootCtx
      : contexts.get(contextValue) ?? legacyStorage.getStore()?.graphqlRootCtx
    if (!rootCtx) return invokeResolver(resolve, this, arguments, isJit)

    const infoPath = info?.path
    const config = rootCtx.config
    const traceResolver = !depthDisabled && shouldInstrumentNode(config, infoPath)

    // pathString built incrementally off the parent's cached value
    // (rootCtx.pathCache, keyed by path node) — avoids re-walking the whole
    // path linked-list on every resolver call, which is O(depth) per call for
    // deeply nested resolvers. Shared between the IAST publish and the field
    // record. Collapse-aware: list-index segments become '*'.
    let pathString
    let collapsedKey
    if (infoPath && (hasIastSub || traceResolver)) {
      const pathCache = rootCtx.pathCache ??= new Map()
      pathString = buildCachedPathString(infoPath, pathCache, config.collapse)
      if (config.collapse) collapsedKey = pathString
    }

    // IAST and AppSec subscribers see EVERY resolver call, regardless of
    // depth or collapse. The depth knob caps span creation only.
    if (hasIastSub) {
      iastResolveCh.publish({ rootCtx, args, info, path: pathToArray(infoPath), pathString })
    }
    if (hasResolverSub) {
      resolverStartCh.publish({
        abortController: rootCtx.abortController,
        resolverInfo: getResolverInfo(info, args),
      })
    }

    if (rootCtx.abortController?.signal.aborted) {
      throw new AbortError('Aborted')
    }

    if (!traceResolver) {
      return invokeResolver(resolve, this, arguments, isJit)
    }

    // Compilations performed while tracing is disabled have no static JIT
    // descriptor. Their resolver-info path nodes are recreated for each
    // resolver, so use the stable path string to preserve span parenting.
    const useStringKey = config.collapse || isJit
    const fieldKey = useStringKey ? pathString : infoPath
    const parentTypeName = info.parentType.name
    let field = rootCtx.fields.get(fieldKey)
    const collapsedField = field
    if (config.collapse && field !== undefined && field.parentTypeName !== parentTypeName) {
      const parentTypeFields = field.parentTypeFields
      if (parentTypeFields?.parentTypeName === undefined) {
        field = parentTypeFields?.get(parentTypeName)
      } else if (parentTypeFields.parentTypeName === parentTypeName) {
        field = parentTypeFields
      } else {
        field = undefined
      }
      if (field && infoPath.typename === undefined) {
        cacheFieldByPath(rootCtx, infoPath, field)
      }
    }
    const isFirst = !field

    if (isFirst) {
      field = {
        fieldNode: info.fieldNodes?.[0],
        fieldName: info.fieldName,
        parentTypeName,
        returnType: info.returnType,
        baseTypeName: getBaseTypeName(info.returnType),
        endTime: PENDING_FIELD_END_TIME,
        infoPath,
        jitPathKey: isJit,
        pathString,
        collapsedKey: collapsedKey ?? pathString,
        span: null,
        // Set by startResolveSpan; collapsed siblings reuse currentStore.
        parentStore: null,
        currentStore: null,
      }
      if (config.collapse && collapsedField) {
        const parentTypeFields = collapsedField.parentTypeFields
        if (parentTypeFields === undefined) {
          collapsedField.parentTypeFields = field
        } else if (parentTypeFields.parentTypeName === undefined) {
          parentTypeFields.set(parentTypeName, field)
        } else {
          const fieldsByParentType = new Map()
            .set(collapsedField.parentTypeName, collapsedField)
            .set(parentTypeFields.parentTypeName, parentTypeFields)
            .set(parentTypeName, field)
          collapsedField.parentTypeFields = fieldsByParentType
        }
        if (infoPath.typename === undefined) {
          cacheFieldByPath(rootCtx, infoPath, field)
        }
      } else {
        rootCtx.fields.set(fieldKey, field)
      }
    } else {
      field.endTime = REUSED_FIELD_END_TIME
      return callInCollapsedScope(
        resolve,
        this,
        arguments,
        field,
        isJit
      )
    }

    const executeSpan = rootCtx.executeSpan
    const startTime = executeSpan._getTime()
    rootCtx.plugin.startResolveSpan(field, rootCtx, executeSpan, startTime, info.variableValues)

    /**
     * @param {unknown} error
     * @param {unknown} res
     * @param {boolean} failed
     */
    const finishField = (error, res, failed) => {
      rootCtx.plugin?.completeResolveSpan(rootCtx, field, error, res, failed)
    }
    return callInAsyncScope(resolve, this, arguments, field.currentStore, finishField, isJit)
  }

  if (isJit) {
    jitResolvers.set(resolve, resolveAsync)
  } else {
    patchedResolvers.add(resolveAsync)
  }
  originalResolvers.set(resolveAsync, resolve)
  return resolveAsync
}

/**
 * @param {GraphQLFieldResolver} resolve
 * @returns {GraphQLFieldResolver}
 */
function unwrapResolve (resolve) {
  return originalResolvers.get(resolve) ?? resolve
}

/**
 * @param {object} rootCtx
 * @param {number} descriptorId
 * @param {GraphQLFieldResolver} resolve
 * @param {unknown} self
 * @param {unknown} source
 * @param {Record<string, unknown>} args
 * @param {unknown} contextValue
 * @param {import('graphql').GraphQLResolveInfo} info
 * @returns {unknown}
 */
function resolveCompiledJitField (rootCtx, descriptorId, resolve, self, source, args, contextValue, info) {
  const descriptor = rootCtx.jitPlan.fields[descriptorId]
  const config = rootCtx.config
  const path = config.collapse ? undefined : pathToArray(info.path)
  const pathString = path ? path.join('.') : descriptor.collapsedPath

  if (rootCtx.hasIastSub) {
    iastResolveCh.publish({
      rootCtx,
      args,
      info,
      path: path ?? pathToArray(info.path),
      pathString,
    })
  }
  if (rootCtx.hasResolverSub) {
    resolverStartCh.publish({
      abortController: rootCtx.abortController,
      resolverInfo: getResolverInfo(info, args),
    })
  }

  if (rootCtx.abortController?.signal.aborted) {
    throw new AbortError('Aborted')
  }

  const depth = config.countListIndices ? descriptor.pathDepth : descriptor.selectionDepth
  if (rootCtx.depthDisabled || (config.depth >= 0 && config.depth < depth)) {
    return resolve.call(self, source, args, contextValue, info)
  }

  let field
  if (config.collapse) {
    field = rootCtx.jitFields[descriptor.id]
  } else {
    const fieldKey = `${descriptor.id}:${pathString}`
    field = rootCtx.jitFieldsByPath.get(fieldKey)
  }
  if (field) {
    field.endTime = REUSED_FIELD_END_TIME
    if (legacyStorage.getStore() !== field.currentStore) {
      legacyStorage.enterWith(field.currentStore)
    }
    return resolve.call(self, source, args, contextValue, info)
  }

  field = startJitField(
    rootCtx,
    descriptor,
    pathString,
    path ?? descriptor.collapsedPathSegments,
    info.variableValues,
    info.path
  )

  /**
   * @param {unknown} error
   * @param {unknown} result
   */
  const finishField = (error, result) => {
    rootCtx.plugin?.completeResolveSpan(rootCtx, field, error, result)
  }
  return callCompiledJitInAsyncScope(
    resolve,
    self,
    source,
    args,
    contextValue,
    info,
    field.currentStore,
    finishField
  )
}

/**
 * @param {object} rootCtx
 * @param {JitDescriptor} descriptor
 * @param {string} pathString
 * @param {(string | number)[]} path
 * @param {Record<string, unknown> | undefined} variableValues
 * @param {object | undefined} [infoPath]
 * @returns {object}
 */
function startJitField (rootCtx, descriptor, pathString, path, variableValues, infoPath) {
  const field = {
    fieldNode: descriptor.fieldNode,
    fieldName: descriptor.fieldName,
    parentTypeName: descriptor.parentTypeName,
    returnType: descriptor.returnType,
    baseTypeName: descriptor.baseTypeName,
    endTime: PENDING_FIELD_END_TIME,
    infoPath,
    pathString,
    collapsedKey: pathString,
    resource: descriptor.resource,
    span: null,
    parentStore: null,
    currentStore: null,
    isSharedJitField: rootCtx.config.collapse && descriptor.pathDepth !== descriptor.selectionDepth,
    tags: rootCtx.config.collapse && !rootCtx.config.source ? descriptor.tags : undefined,
  }
  if (rootCtx.config.collapse) {
    rootCtx.jitFields[descriptor.id] = field
  } else {
    rootCtx.jitFieldsByPath.set(`${descriptor.id}:${pathString}`, field)
  }

  let parentField = null
  if (descriptor.parentId !== undefined) {
    if (rootCtx.config.collapse) {
      parentField = rootCtx.jitFields[descriptor.parentId]
    } else {
      const parentPath = path.slice(0, -1)
      while (typeof parentPath.at(-1) === 'number') parentPath.pop()
      parentField = rootCtx.jitFieldsByPath.get(`${descriptor.parentId}:${parentPath.join('.')}`)
    }
  }
  const executeSpan = rootCtx.executeSpan
  rootCtx.plugin.startResolveSpan(field, rootCtx, executeSpan, executeSpan._getTime(), variableValues, parentField)
  return field
}

/**
 * @param {object} rootCtx
 * @param {number} descriptorId
 * @param {unknown} error
 */
function recordJitResolverError (rootCtx, descriptorId, error) {
  const field = rootCtx?.jitFields?.[descriptorId]
  if (!field?.isSharedJitField) return

  recordResolveError(field, error)
}

/**
 * @param {object} rootCtx
 * @param {number} descriptorId
 * @param {Record<string, unknown>} source
 * @param {(string | number)[] | undefined} path
 * @returns {unknown}
 */
function resolveJitDefault (rootCtx, descriptorId, source, path) {
  const descriptor = rootCtx.jitPlan.fields[descriptorId]
  const pathString = path ? path.join('.') : descriptor.collapsedPath
  const field = startJitField(
    rootCtx,
    descriptor,
    pathString,
    path ?? descriptor.collapsedPathSegments,
    rootCtx.variableValues
  )
  if (rootCtx.config.collapse && descriptor.pathDepth !== descriptor.selectionDepth) {
    field.endTime = REUSED_FIELD_END_TIME
  }

  let result
  try {
    result = legacyStorage.run(field.currentStore, () => source[descriptor.fieldName])
  } catch (error) {
    rootCtx.plugin.completeResolveSpan(rootCtx, field, error)
    throw error
  }

  rootCtx.plugin.completeResolveSpan(rootCtx, field, undefined, result)
  return result
}

/**
 * @param {object} rootCtx
 * @param {number} descriptorId
 * @param {Record<string, unknown>} source
 * @param {(string | number)[] | undefined} path
 * @returns {unknown}
 */
function readJitDefaultInScope (rootCtx, descriptorId, source, path) {
  const descriptor = rootCtx.jitPlan.fields[descriptorId]
  const field = rootCtx.config.collapse
    ? rootCtx.jitFields?.[descriptorId]
    : rootCtx.jitFieldsByPath?.get(`${descriptorId}:${path.join('.')}`)
  if (!field) return source[descriptor.fieldName]

  if (legacyStorage.getStore() !== field.currentStore) {
    legacyStorage.enterWith(field.currentStore)
  }
  return source[descriptor.fieldName]
}

/**
 * @param {object} rootCtx
 * @param {number} descriptorId
 * @param {Record<string, unknown>} source
 * @param {(string | number)[] | undefined} path
 * @param {ArgumentFactory | undefined} argumentFactory
 * @returns {unknown}
 */
function resolveJitDefaultInvocation (rootCtx, descriptorId, source, path, argumentFactory) {
  const descriptor = rootCtx.jitPlan.fields[descriptorId]
  const pathString = path ? path.join('.') : descriptor.collapsedPath
  if (rootCtx.hasIastSub || rootCtx.hasResolverSub) {
    const info = {
      fieldName: descriptor.fieldName,
      fieldNodes: descriptor.fieldNodes,
    }
    if (rootCtx.hasIastSub) {
      iastResolveCh.publish({
        rootCtx,
        args: getJitDefaultArguments(rootCtx, descriptor, argumentFactory, true),
        info,
        path: path ?? descriptor.collapsedPathSegments,
        pathString,
      })
    }
    if (rootCtx.hasResolverSub) {
      resolverStartCh.publish({
        abortController: rootCtx.abortController,
        resolverInfo: getResolverInfo(
          info,
          getJitDefaultArguments(rootCtx, descriptor, argumentFactory, false)
        ),
      })
    }
  }
  if (rootCtx.abortController?.signal.aborted) {
    throw new AbortError('Aborted')
  }

  const depth = rootCtx.config.countListIndices ? descriptor.pathDepth : descriptor.selectionDepth
  if (rootCtx.depthDisabled || (rootCtx.config.depth >= 0 && rootCtx.config.depth < depth)) {
    if (!rootCtx.depthDisabled && rootCtx.config.collapse) rootCtx.jitFields[descriptorId] = false
    return source[descriptor.fieldName]
  }

  const field = rootCtx.config.collapse
    ? rootCtx.jitFields[descriptorId]
    : rootCtx.jitFieldsByPath.get(`${descriptorId}:${pathString}`)
  if (field === undefined) {
    return resolveJitDefault(rootCtx, descriptorId, source, path)
  }
  return readJitDefaultInScope(rootCtx, descriptorId, source, path)
}

/**
 * @param {object} rootCtx
 * @param {JitDescriptor} descriptor
 * @param {ArgumentFactory | undefined} argumentFactory
 * @param {boolean} mutable
 * @returns {Record<string, unknown> | undefined}
 */
function getJitDefaultArguments (rootCtx, descriptor, argumentFactory, mutable) {
  if (mutable) {
    return argumentFactory === undefined
      ? {}
      : argumentFactory(rootCtx.variableValues, cloneArgumentValue)
  }
  if (descriptor.hasArgumentVariables) {
    return argumentFactory(rootCtx.variableValues)
  }
  return descriptor.staticArguments
}

/**
 * @param {unknown} value
 * @param {WeakMap<object, object>} [clones]
 * @returns {unknown}
 */
function cloneArgumentValue (value, clones) {
  if (value === null || typeof value !== 'object') return value

  // Lists get their own branch: Object.keys materializes the index strings and
  // the clone is then filled through them instead of by index.
  if (Array.isArray(value)) {
    const { length } = value
    if (length === 0) return value

    clones ??= new WeakMap()
    const cached = clones.get(value)
    if (cached !== undefined) return cached

    const clone = new Array(length)
    clones.set(value, clone)
    for (let index = 0; index < length; index++) {
      clone[index] = cloneArgumentValue(value[index], clones)
    }
    return clone
  }

  const keys = Object.keys(value)
  if (keys.length === 0) return value

  clones ??= new WeakMap()
  const cached = clones.get(value)
  if (cached !== undefined) return cached

  const clone = {}
  clones.set(value, clone)
  for (const name of keys) {
    clone[name] = cloneArgumentValue(value[name], clones)
  }
  return clone
}

/**
 * @param {GraphQLFieldResolver} resolve
 */
function wrapJitResolve (resolve) {
  return wrapResolve(resolve, true)
}

function wrapFields (type, schema) {
  if (!type || !markWalked(schema, type)) return

  const tag = type[Symbol.toStringTag]

  // Union types (e.g. Apollo Federation's `_Entity`) hold their members on
  // `_types`, not `_fields`. Their member object types are reachable only here,
  // so descend into each to wrap the entity resolvers a `_entities` query runs.
  if (tag === 'GraphQLUnionType') {
    for (const member of type.getTypes()) wrapFields(member, schema)
    return
  }

  if (type._fields) {
    for (const field of Object.values(type._fields)) {
      wrapFieldResolve(field)
      wrapFieldType(field, schema)
    }
  }

  // Interface implementations carry their own resolvers and are reachable only
  // through `getPossibleTypes`; an interface return type alone never wraps them.
  if (schema && tag === 'GraphQLInterfaceType') {
    for (const impl of schema.getPossibleTypes(type)) wrapFields(impl, schema)
  }
}

// Marks the guard on entry so recursive types (a field looping back to its own
// type, an interface an implementation returns) terminate the walk.
function markWalked (schema, type) {
  let walked = walkedTypes.get(schema)
  if (walked === undefined) {
    walked = new WeakSet()
    walkedTypes.set(schema, walked)
  }
  if (walked.has(type)) return false
  walked.add(type)
  return true
}

function wrapFieldResolve (field) {
  if (!field?.resolve) return
  field.resolve = wrapResolve(field.resolve)
}

function wrapFieldType (field, schema) {
  if (!field?.type) return

  let unwrapped = field.type
  while (unwrapped.ofType) unwrapped = unwrapped.ofType

  wrapFields(unwrapped, schema)
}

/**
 * @param {GraphQLFieldResolver} resolve
 * @param {unknown} self
 * @param {ArgumentsList} args
 * @param {boolean} isJit
 * @returns {unknown}
 */
function invokeResolver (resolve, self, args, isJit) {
  return isJit
    ? resolve.call(self, args[0], args[1], args[2], args[3])
    : resolve.apply(self, args)
}

/**
 * @param {GraphQLFieldResolver} fn
 * @param {unknown} thisArg
 * @param {ArgumentsList} args
 * @param {object} field
 * @param {boolean} isJit
 * @returns {unknown}
 */
function callInCollapsedScope (fn, thisArg, args, field, isJit) {
  if (legacyStorage.getStore() !== field.currentStore) {
    legacyStorage.enterWith(field.currentStore)
  }
  return invokeResolver(fn, thisArg, args, isJit)
}

/**
 * @param {GraphQLFieldResolver} resolve
 * @param {unknown} self
 * @param {unknown} source
 * @param {Record<string, unknown>} args
 * @param {unknown} contextValue
 * @param {import('graphql').GraphQLResolveInfo} info
 * @returns {unknown}
 */
function invokeCompiledJitResolver (resolve, self, source, args, contextValue, info) {
  return resolve.call(self, source, args, contextValue, info)
}

/**
 * @param {GraphQLFieldResolver} resolve
 * @param {unknown} self
 * @param {unknown} source
 * @param {Record<string, unknown>} args
 * @param {unknown} contextValue
 * @param {import('graphql').GraphQLResolveInfo} info
 * @param {object} store
 * @param {(error: unknown, result?: unknown) => void} callback
 * @returns {unknown}
 */
function callCompiledJitInAsyncScope (resolve, self, source, args, contextValue, info, store, callback) {
  try {
    const result = legacyStorage.run(
      store,
      invokeCompiledJitResolver,
      resolve,
      self,
      source,
      args,
      contextValue,
      info
    )
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      return observeThenable(result, callback)
    }
    callback(null, result)
    return result
  } catch (error) {
    callback(error)
    throw error
  }
}

/**
 * Runs the resolver inside `store`, including any code after an internal
 * `await`. A `.then()` the caller attaches afterward runs outside `store`.
 *
 * @param {GraphQLFieldResolver} fn
 * @param {unknown} thisArg
 * @param {ArgumentsList} args
 * @param {object} store
 * @param {(error: unknown, result?: unknown, failed?: boolean) => void} callback
 * @param {boolean} isJit
 * @returns {unknown}
 */
function callInAsyncScope (fn, thisArg, args, store, callback, isJit) {
  try {
    const result = legacyStorage.run(store, invokeResolver, fn, thisArg, args, isJit)
    if (typeof result?.then === 'function' && (!isJit || (result !== null && typeof result === 'object'))) {
      return observeThenable(result, callback)
    }
    callback(null, result)
    return result
  } catch (error) {
    callback(error, undefined, true)
    throw error
  }
}

/**
 * Observes settlement without standing between the consumer and the resolver's
 * own `then`. Three constraints hold at once, each with its own regression test:
 * the foreign `then` runs exactly once (`should not re-execute thenables from
 * resolvers` — a Mongoose `Query` throws on the second call), the return value
 * stays then-able, and the consumer receives whatever the foreign `then` returned.
 *
 * `return thenable.then(onSettled)` satisfies the first two and breaks the third:
 * only `Promise.prototype.then` is guaranteed to return a promise, and
 * `await`/`Promise.resolve` discard that return value, so a thenable returning
 * `this` or a plain value is legal and invisible everywhere except here — see
 * `CustomThenableSuccess` in jit.spec.js, which resolves with 'actual' but returns
 * 'wrong'. Forwarding `then` lets the consumer make that single call itself and
 * get its real return value, while the settlement callbacks pass through us.
 *
 * @param {Thenable} thenable
 * @param {(error: unknown, result?: unknown, failed?: boolean) => void} callback
 * @returns {Thenable}
 */
function observeThenable (thenable, callback) {
  return {
    /**
     * @param {ThenableCallback} [onFulfilled]
     * @param {ThenableCallback} [onRejected]
     */
    // eslint-disable-next-line unicorn/no-thenable -- graphql-jit intentionally consumes this adapter as a thenable.
    then (onFulfilled, onRejected) {
      return thenable.then(
        /**
         * @param {unknown} result
         */
        result => {
          callback(null, result)
          return onFulfilled ? onFulfilled(result) : result
        },
        /**
         * @param {unknown} error
         */
        error => {
          callback(error, undefined, true)
          if (onRejected) return onRejected(error)
          throw error
        }
      )
    },
  }
}

function pathToArray (path) {
  let length = 0
  for (let curr = path; curr; curr = curr.prev) {
    length += 1
  }

  const flattened = new Array(length)
  let index = length
  for (let curr = path; curr; curr = curr.prev) {
    flattened[--index] = curr.key
  }
  return flattened
}

// Build the dotted pathString for a resolver's path node, caching per node on
// rootCtx.pathCache so each call reuses the parent's already-built string
// instead of re-walking the whole path linked-list (O(1) amortized per call).
// Collapse-aware: numeric (list-index) segments become '*'. The recursion
// handles the cold path where a parent node never hit a resolver (graphql
// inserts a synthetic array-index node between a list field and its items).
function buildCachedPathString (path, cache, collapse) {
  const cached = cache.get(path)
  if (cached !== undefined) return cached

  const key = path.key
  const segment = collapse && typeof key !== 'string' ? '*' : key
  const prev = path.prev

  const pathString = prev === undefined
    ? String(segment)
    : `${buildCachedPathString(prev, cache, collapse)}.${segment}`
  cache.set(path, pathString)
  return pathString
}

/**
 * @param {{ hasFieldsByPath?: boolean, fields: Map<string|object, object> }} rootCtx
 * @param {object} path
 * @param {object} field
 */
function cacheFieldByPath (rootCtx, path, field) {
  // Leaf fields cannot parent resolver spans, so their concrete paths are never read.
  if (field.fieldNode?.selectionSet === undefined) return

  // Concrete info path objects cannot collide with collapsed path string keys.
  rootCtx.hasFieldsByPath = true
  rootCtx.fields.set(path, field)
}

// Depth filtering directly on the linked-list node — no array allocation needed.
// config.depth < 0 means no limit. Only selection-set segments (string keys)
// count toward depth; list indices are execution artifacts and are transparent.
// On the v5 line `countListIndices` keeps the legacy behaviour of counting every
// node when collapsing folds the numeric indices into '*'.
function shouldInstrumentNode (config, path) {
  if (config.depth < 0) return true

  let depth = 0
  if (config.countListIndices) {
    for (let curr = path; curr; curr = curr.prev) depth++
  } else {
    for (let curr = path; curr; curr = curr.prev) {
      if (typeof curr.key === 'string') depth++
    }
  }

  return config.depth >= depth
}

function getParentField (rootCtx, field) {
  for (let curr = field.infoPath?.prev; curr; curr = curr.prev) {
    const fieldKey = rootCtx.config.collapse || field.jitPathKey ? rootCtx.pathCache.get(curr) : curr
    const innerField = rootCtx.fields.get(fieldKey)
    if (innerField) {
      if (curr.typename === undefined) {
        if (rootCtx.hasFieldsByPath) {
          const fieldByPath = rootCtx.fields.get(curr)
          if (fieldByPath) return fieldByPath
        }
        return innerField
      }
      if (innerField.parentTypeName === curr.typename) return innerField

      const parentTypeFields = innerField.parentTypeFields
      if (parentTypeFields.parentTypeName === undefined) return parentTypeFields.get(curr.typename)
      return parentTypeFields
    }
  }

  return null
}

// Build the resolverInfo payload that AppSec's datadog:graphql:resolver:start
// subscriber expects: { [fieldName]: { ...args, ...directives } }.
function getResolverInfo (info, args) {
  let resolverVars = args ? { ...args } : undefined

  const directives = info.fieldNodes?.[0]?.directives
  if (Array.isArray(directives)) {
    for (const directive of directives) {
      if (!directive.arguments?.length) continue

      const argList = {}
      for (const argument of directive.arguments) {
        argList[argument.name.value] = argument.value.value
      }

      resolverVars ??= {}
      resolverVars[directive.name.value] = argList
    }
  }

  return resolverVars === undefined ? null : { [info.fieldName]: resolverVars }
}

// --- arg / context normalization ---------------------------------------------

// graphql.execute accepts either a single args object or positional arguments;
// the object form is a lone non-array object in slot 0.
function isObjectForm (args) {
  return args?.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
}

function readArgs (args, objectForm) {
  if (!args || args.length === 0) return {}

  if (objectForm) {
    return args[0]
  }

  return {
    schema: args[0],
    document: args[1],
    rootValue: args[2],
    contextValue: args[3],
    variableValues: args[4],
    operationName: args[5],
    fieldResolver: args[6],
  }
}

// No user input may be modified. Object-form clones rawArgs[0]; positional
// form rewrites its own arguments slots (no caller-observable mutation).
// Returns the readArgs-shaped view of the (possibly cloned) args so the caller
// doesn't have to re-readArgs after the swap.
function setWrappedFieldResolver (rawArgs, args, objectForm, defaultFieldResolver) {
  if (!rawArgs || rawArgs.length === 0) return args

  if (objectForm) {
    const clone = {
      ...args,
      fieldResolver: wrapResolve(args.fieldResolver || defaultFieldResolver),
    }
    rawArgs[0] = clone
    return clone
  }

  rawArgs[6] = wrapResolve(args.fieldResolver || defaultFieldResolver)
  if (rawArgs.length < 7) rawArgs.length = 7
  args.fieldResolver = rawArgs[6]
  return args
}

function isWeakMapKey (value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/**
 * @param {unknown} result
 * @returns {object | undefined}
 */
function getIncrementalIterator (result) {
  if (result === null || typeof result !== 'object') return

  if ('initialResult' in result && typeof result.subsequentResults?.next === 'function') {
    return result.subsequentResults
  }
  if (typeof result.next === 'function' && typeof result[Symbol.asyncIterator] === 'function') {
    return result
  }
}

/**
 * @param {object} iterator
 * @param {(result?: unknown, error?: unknown, cancelled?: boolean, complete?: boolean) => void} observe
 */
function observeIncrementalIterator (iterator, observe) {
  let activeObserver = observe

  /**
   * @param {unknown} [result]
   * @param {unknown} [error]
   * @param {boolean} [cancelled]
   * @param {boolean} [complete]
   */
  function notify (result, error, cancelled, complete) {
    if (!activeObserver) return

    const callback = activeObserver
    if (complete) activeObserver = undefined
    callback(result, error, cancelled, complete)
  }

  // Orchestrion cannot reach Promise-resolved or nested iterators. Shimmer adds measurable work to each execution.
  wrapIteratorMethod(iterator, 'next', false, notify)
  wrapIteratorMethod(iterator, 'return', true, notify)
  wrapIteratorMethod(iterator, 'throw', true, notify)
  wrapIteratorMethod(iterator, asyncDisposeSymbol, true, notify)
}

/**
 * @param {object} iterator
 * @param {string | symbol} name
 * @param {boolean} terminal
 * @param {(result?: unknown, error?: unknown, cancelled?: boolean, complete?: boolean) => void} notify
 */
function wrapIteratorMethod (iterator, name, terminal, notify) {
  const method = iterator[name]
  if (typeof method !== 'function') return

  iterator[name] = function () {
    const result = method.apply(this, arguments)
    result.then((value) => {
      const complete = terminal || value?.done || value?.value?.hasNext === false
      notify(value?.value, undefined, terminal, complete)
    }, error => notify(undefined, error, true, true))
    return result
  }
}

/**
 * @param {object} config
 * @param {DatadogSpan} span
 * @param {unknown} result
 */
function tagIncrementalResult (config, span, result) {
  if (result === null || typeof result !== 'object') return

  tagExecutionErrors(config, span, result.errors)
  if (result.incremental) {
    for (const entry of result.incremental) {
      tagExecutionErrors(config, span, entry.errors)
    }
  }
}

/**
 * @param {object} config
 * @param {DatadogSpan} span
 * @param {unknown[] | undefined} errors
 */
function tagExecutionErrors (config, span, errors) {
  if (!errors?.length) return

  if (!span.context().getTag('error')) span.setTag('error', errors[0])
  for (const error of errors) {
    extractErrorIntoSpanEvent(config, span, error)
  }
}

/**
 * @param {object} rootCtx
 * @param {boolean} [finishPendingFields]
 */
function releaseRootContext (rootCtx, finishPendingFields) {
  const endTime = rootCtx.executeSpan._getTime()
  if (rootCtx.resolveFields !== undefined) {
    if (rootCtx.resolveHooksPending || rootCtx.jitResolveHooksPending) {
      runResolveHooks(rootCtx)
    }
    for (let field = rootCtx.resolveFields; field; field = field.nextResolveField) {
      const holder = field.currentStore?.graphqlResolveField
      if (holder?.field === field) {
        holder.field = undefined
        field.currentStore.graphqlResolveField = undefined
      }
      field.span.finish(field.endTime > PENDING_FIELD_END_TIME ? field.endTime : endTime)
    }
  } else if (finishPendingFields && rootCtx.fields !== undefined) {
    for (const field of rootCtx.fields.values()) {
      field.span.finish(endTime)
    }
  }

  // Resolver-created async resources retain copied stores that all share this owner.
  for (const key of Object.keys(rootCtx)) {
    rootCtx[key] = undefined
  }
}

/**
 * @param {object} rootCtx
 */
function runResolveHooks (rootCtx) {
  rootCtx.resolveHooksPending = undefined
  rootCtx.jitResolveHooksPending = undefined

  for (let field = rootCtx.resolveFields; field; field = field.nextResolveField) {
    if (field.resolveHookContext === undefined) continue

    rootCtx.config.hooks.resolve(field.span, field.resolveHookContext)
    field.resolveHookContext = undefined
  }
}

/**
 * @param {object} field
 * @param {unknown} error
 * @param {unknown} result
 * @returns {{ fieldName: string, path: string, error: unknown, result: unknown }}
 */
function createResolveHookContext (field, error, result) {
  return {
    fieldName: field.fieldName,
    path: field.pathString,
    error: error || null,
    // Any thenable from any realm must stay undefined so the hook does not see an unresolved promise.
    result: error || typeof result?.then === 'function' ? undefined : result,
  }
}

// Fallback resolver used when graphql.execute() is called without an explicit
// fieldResolver and the schema field has no .resolve. Mirrors graphql's own
// defaultFieldResolver: property access on source, calling it if it's a function.
// Defined locally so it survives dd-trace plugin-manager reloads (agent.load()
// recreates globalThis[Symbol.for('dd-trace')], so capturing defaultFieldResolver
// via ddGlobal at IITM hook time would lose the reference across test suites).
function defaultFieldResolver (source, args, contextValue, info) {
  if ((typeof source === 'object' && source !== null) || typeof source === 'function') {
    const property = source[info.fieldName]
    if (typeof property === 'function') return source[info.fieldName](args, contextValue, info)
    return property
  }
}

function addVariableTags (config, span, variableValues) {
  if (!variableValues || !config.variables) return

  const tags = {}
  const variables = config.variables(variableValues)
  for (const [param, value] of Object.entries(variables)) {
    tags[`graphql.variables.${param}`] = value
  }

  span.addTags(tags)
}

module.exports = GraphQLExecutePlugin
module.exports.readJitDefaultInScope = readJitDefaultInScope
module.exports.recordJitResolverError = recordJitResolverError
module.exports.resolveCompiledJitField = resolveCompiledJitField
module.exports.resolveJitDefaultInvocation = resolveJitDefaultInvocation
module.exports.unwrapJitResolve = unwrapResolve
module.exports.wrapJitResolve = wrapJitResolve
