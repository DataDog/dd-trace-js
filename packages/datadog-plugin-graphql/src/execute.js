'use strict'

const dc = require('dc-polyfill')

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const GraphQLParsePlugin = require('./parse')
const {
  extractErrorIntoSpanEvent,
  getOperation,
  getSignature,
  isApolloHealthCheck,
  refineRequestSpan,
} = require('./utils')

/**
 * @typedef {import('../../dd-trace/src/opentracing/span')} DatadogSpan
 * @typedef {import('graphql').GraphQLFieldResolver<unknown, unknown>} GraphQLFieldResolver
 * @typedef {{
 *   schema?: import('graphql').GraphQLSchema,
 *   document?: import('graphql').DocumentNode,
 *   rootValue?: unknown,
 *   contextValue?: unknown,
 *   variableValues?: Record<string, unknown>,
 *   operationName?: string,
 *   fieldResolver?: GraphQLFieldResolver
 * }} ExecutionArguments
 * @typedef {{
 *   id: number,
 *   baseTypeName?: string,
 *   collapsedPath: string,
 *   fieldName: string,
 *   fieldNode?: import('graphql').FieldNode,
 *   parentId?: number,
 *   parentTypeName: string,
 *   pathDepth: number,
 *   returnType: import('graphql').GraphQLOutputType,
 *   selectionDepth: number
 * }} JitFieldDescriptor
 */

const legacyStorage = storage('legacy')

const iastResolveCh = dc.channel('apm:graphql:resolve:start')
const resolverStartCh = dc.channel('datadog:graphql:resolver:start')
const updateFieldCh = dc.channel('apm:graphql:resolve:updateField')

// AppSec/WAF abort gate. Published synchronously from bindStart with a
// payload carrying the abortController; subscribers that call
// `payload.abortController.abort()` signal a pre-execute abort. bindStart
// observes the aborted signal by replacing `ctx.arguments[0]` with a Proxy
// whose getters throw AbortError — the orchestrion-emitted wrapper's
// `try { __apm$traced() } catch { ...; throw err }` block then propagates
// the AbortError to the caller of graphql.execute.
const startExecuteCh = dc.channel('apm:graphql:execute:start')

const contexts = new WeakMap()
const instrumentedArgs = new WeakSet()

const patchedResolvers = new WeakSet()
const patchedJitResolvers = new WeakSet()
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
 * @param {AbortController} abortController
 * @param {{ fields: object[] } | undefined} jitPlan
 * @param {Record<string, unknown> | undefined} variableValues
 * @returns {object}
 */
function createRootContext (plugin, executeSpan, source, abortController, jitPlan, variableValues) {
  const rootCtx = {
    source,
    config: plugin.config,
    abortController,
    executeSpan,
    plugin,
    filteredVariablesKey: NO_VARIABLES_CACHED,
    filteredVariables: undefined,
    hasIastSub: iastResolveCh.hasSubscribers,
    hasResolverSub: resolverStartCh.hasSubscribers,
    variableValues,
  }

  if (jitPlan) {
    rootCtx.jitPlan = jitPlan
    if (plugin.config.collapse) {
      rootCtx.jitFields = new Array(jitPlan.fields.length)
    } else {
      rootCtx.jitFieldsByPath = new Map()
    }
  }
  if (!jitPlan || !plugin.config.collapse) {
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
   */
  abortExecution (ctx) {
    // graphql.execute destructures its first argument before doing work.
    ctx.arguments[0] = new Proxy({}, {
      get () { throw new AbortError('Aborted') },
      /* istanbul ignore next: retain the abort if graphql switches to an `in` check. */
      has () { throw new AbortError('Aborted') },
    })
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

  /** @param {object} ctx */
  bindStart (ctx) {
    const args = this.readExecutionArgs(ctx)
    if (!args) return ctx.currentStore

    const { contextValue } = args
    const document = args.document
    const docSource = document ? GraphQLParsePlugin.documentSources.get(document) : undefined
    const operation = getOperation(document, args.operationName)

    const type = operation?.operation
    const name = operation?.name?.value
    const source = this.config.source && docSource

    // Apollo Server may execute a cached document without parsing it first.
    // Match the full gateway operation here so caller-owned AST transformations
    // cannot suppress execute/resolver AppSec and IAST channels.
    if (name === '__ApolloServiceHealthCheck__' &&
        document.definitions.length === 1 &&
        isApolloHealthCheck(operation)) {
      ctx.ddSkipped = true
      return ctx.currentStore
    }

    const signature = getSignature(document, name, type, this.config.signature)
    const requestStore =
      /** @type {{ graphqlRequestSpan?: DatadogSpan } | undefined} */ (legacyStorage.getStore())
    refineRequestSpan(requestStore?.graphqlRequestSpan, signature, type, name)

    ctx.collapse = this.config.collapse

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

    const abortController = new AbortController()

    // AppSec/WAF synchronous-abort gate. Publish before any resolver-wrapping
    // work — if a subscriber aborts, none of that work matters because we'll
    // make execute's body throw AbortError before it reaches any resolvers.
    // bindStart runs as a bindStore transform on
    // tracing:orchestrion:graphql:apm:graphql:execute:start, which fires
    // BEFORE the orchestrion-emitted wrapper publishes its own :start and
    // BEFORE the wrapped fn runs. The subscriber gets the abortController
    // synchronously; on return we observe `signal.aborted` and act.
    if (startExecuteCh.hasSubscribers) {
      startExecuteCh.publish({ abortController, args })
      if (abortController.signal.aborted) {
        ctx.ddAborted = true
        this.abortExecution(ctx)
        return ctx.currentStore
      }
    }

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

    // Synchronous execute() throw (e.g. execute(null, doc)) — error handler
    // already tagged the span.
    if (ctx.error) {
      if (ctx.ddAborted) {
        span.finish()
      } else {
        this.#finishSpan(ctx, span)
      }
      return ctx.parentStore
    }

    const result = ctx.result

    if (typeof result?.then === 'function') {
      result.then(
        (res) => this.#finishSpan(ctx, span, res),
        (err) => this.#finishSpan(ctx, span, undefined, err)
      )
    } else {
      this.#finishSpan(ctx, span, result)
    }

    return ctx.parentStore
  }

  error (ctx) {
    // Pre-execute WAF abort isn't an error condition — opSpan.error must
    // stay 0 per master's contract.
    if (ctx.ddAborted) return
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
   */
  #finishSpan (ctx, span, res, error) {
    if (error !== undefined) {
      span.setTag('error', error)
    }

    if (res?.errors?.length) {
      span.setTag('error', res.errors[0])
      for (const err of res.errors) {
        extractErrorIntoSpanEvent(this.config, span, err)
      }
    }

    if (ctx.ddContextValue) {
      contexts.delete(ctx.ddContextValue)
    }
    if (ctx.ddInstrumentedArgs) {
      instrumentedArgs.delete(ctx.ddInstrumentedArgs)
    }

    this.config.hooks.execute(span, ctx.ddArgs, res)

    span.finish()
  }

  // Public — called from wrapResolve (free function, crosses class boundary).
  // Resolve-span creation is inline at first-encounter; deferring to a batch
  // produces a bursty encoder stall when many spans finish together.
  /**
   * @param {object} field
   * @param {object} rootCtx
   * @param {DatadogSpan} executeSpan
   * @param {number} startTime
   * @param {object | null} [parentField]
   * @returns {DatadogSpan}
   */
  startResolveSpan (field, rootCtx, executeSpan, startTime, parentField) {
    const { fieldNode, fieldName, returnType, baseTypeName, variableValues, collapsedKey } = field

    const parent = parentField === undefined ? getParentField(rootCtx, field) : parentField
    const childOf = parent?.span || executeSpan

    const document = rootCtx.source
    const loc = this.config.source && document && fieldNode && fieldNode.loc
    const source = loc && document.slice(loc.start, loc.end)

    // ctx form: startSpan sets field.currentStore = { ...activeStore, span }
    // without entering it. Only the field's first resolver call runs in that
    // store (isFirst check in wrapResolve); siblings use field.parentStore.
    const span = this.startSpan('graphql.resolve', {
      service: this.config.service,
      resource: `${fieldName}:${returnType}`,
      childOf,
      type: 'graphql',
      startTime,
      meta: {
        'graphql.field.coordinates': `${field.parentTypeName}.${fieldName}`,
        'graphql.field.name': fieldName,
        'graphql.field.path': collapsedKey,
        'graphql.field.type': baseTypeName,
        'graphql.source': source,
      },
    }, field)

    field.span = span

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

  // Public — called from wrapResolve. endTime reflects when the resolver
  // actually completed, not when the field record was created.
  finishResolveSpan (span, field, error, result, endTime) {
    if (error) span.setTag('error', error)

    if (this.config.hooks.resolve) {
      this.config.hooks.resolve(span, {
        fieldName: field.fieldName,
        path: field.pathString,
        error: error || null,
        // Any thenable from any realm — keep undefined so the hook doesn't
        // accidentally see the unresolved promise.
        result: typeof result?.then === 'function' ? undefined : result,
      })
    }

    span.finish(endTime)
  }
}

// --- resolver wrapping --------------------------------------------------------

/**
 * @param {GraphQLFieldResolver} resolve
 * @param {boolean} [isJit]
 */
function wrapResolve (resolve, isJit = false) {
  const patched = isJit ? patchedJitResolvers : patchedResolvers
  if (typeof resolve !== 'function' || patched.has(resolve)) return resolve

  // Replace a schema wrapper with the execution-local JIT variant instead of nesting both.
  resolve = originalResolvers.get(resolve) ?? resolve

  function resolveAsync (source, args, contextValue, info) {
    const hasIastSub = iastResolveCh.hasSubscribers
    const hasResolverSub = resolverStartCh.hasSubscribers

    // Combined fast-path: depth=0 AND no IAST/AppSec subscriber means nothing
    // to do — skip rootCtx lookup, path walk, publish gates.
    if (depthDisabled && !hasIastSub && !hasResolverSub) {
      return resolve.apply(this, arguments)
    }

    const rootCtx = isJit
      ? legacyStorage.getStore()?.graphqlRootCtx
      : contexts.get(contextValue) ?? legacyStorage.getStore()?.graphqlRootCtx
    if (!rootCtx) return resolve.apply(this, arguments)

    if (isJit) {
      const jitField = info?.__ddTraceField
      if (jitField) {
        return resolveJitField(resolve, this, arguments, args, info, rootCtx, jitField)
      }
    }

    const infoPath = info?.path
    const config = rootCtx.config

    // pathString built incrementally off the parent's cached value
    // (rootCtx.pathCache, keyed by path node) — avoids re-walking the whole
    // path linked-list on every resolver call, which is O(depth) per call for
    // deeply nested resolvers. Shared between the IAST publish and the field
    // record. Collapse-aware: list-index segments become '*'.
    let pathString
    let collapsedKey
    if (infoPath) {
      pathString = buildCachedPathString(infoPath, rootCtx.pathCache, config.collapse)
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

    if (depthDisabled || !shouldInstrumentNode(config, infoPath)) {
      if (rootCtx.abortController?.signal.aborted) {
        throw new AbortError('Aborted')
      }

      return resolve.apply(this, arguments)
    }

    const fieldKey = config.collapse ? pathString : infoPath
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
        variableValues: info.variableValues,
        args,
        infoPath,
        pathString,
        collapsedKey: collapsedKey ?? pathString,
        span: null,
        // Set by startResolveSpan; currentStore is used by the first resolver
        // call only, siblings use parentStore (see the isFirst check below).
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
    }

    // Collapsed siblings still publish updateField (master's contract: one
    // publish per resolver call, even when the span is collapsed) and route
    // through callInAsyncScope so the abort signal stops them mid-flight. They
    // run in the parent store, not field.currentStore: the first sibling's
    // synchronous resolver already finished the shared graphql.resolve span, so
    // re-entering its store would parent user spans to a closed span.
    if (!isFirst) {
      return callInAsyncScope(resolve, this, arguments, rootCtx.abortController, field.parentStore, (err) => {
        if (updateFieldCh.hasSubscribers) {
          updateFieldCh.publish({ rootCtx, field, error: err, pathString: field.pathString })
        }
      })
    }

    const executeSpan = rootCtx.executeSpan
    const startTime = executeSpan._getTime()
    const span = rootCtx.plugin.startResolveSpan(field, rootCtx, executeSpan, startTime)

    return callInAsyncScope(resolve, this, arguments, rootCtx.abortController, field.currentStore, (err, res) => {
      const endTime = executeSpan._getTime()
      rootCtx.plugin.finishResolveSpan(span, field, err, res, endTime || startTime)
      if (updateFieldCh.hasSubscribers) {
        updateFieldCh.publish({ rootCtx, field, error: err, pathString: field.pathString })
      }
    })
  }

  patched.add(resolveAsync)
  originalResolvers.set(resolveAsync, resolve)
  return resolveAsync
}

/**
 * @param {GraphQLFieldResolver} resolve
 * @param {unknown} self
 * @param {IArguments} callArguments
 * @param {Record<string, unknown>} args
 * @param {import('graphql').GraphQLResolveInfo & { __ddTraceField: JitFieldDescriptor }} info
 * @param {object} rootCtx
 * @param {JitFieldDescriptor} descriptor
 * @returns {unknown}
 */
function resolveJitField (resolve, self, callArguments, args, info, rootCtx, descriptor) {
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
  if (depthDisabled || (config.depth >= 0 && config.depth < depth)) {
    return resolve.apply(self, callArguments)
  }

  const fieldKey = `${descriptor.id}:${pathString}`
  let field = config.collapse
    ? rootCtx.jitFields[descriptor.id]
    : rootCtx.jitFieldsByPath.get(fieldKey)
  if (field) {
    return resolve.apply(self, callArguments)
  }

  field = {
    fieldNode: descriptor.fieldNode,
    fieldName: descriptor.fieldName,
    parentTypeName: descriptor.parentTypeName,
    returnType: descriptor.returnType,
    baseTypeName: descriptor.baseTypeName,
    variableValues: info.variableValues,
    args,
    infoPath: info.path,
    pathString,
    collapsedKey: pathString,
    span: null,
    parentStore: null,
    currentStore: null,
  }
  if (config.collapse) {
    rootCtx.jitFields[descriptor.id] = field
  } else {
    rootCtx.jitFieldsByPath.set(fieldKey, field)
  }

  const executeSpan = rootCtx.executeSpan
  const startTime = executeSpan._getTime()
  let parentField = null
  if (descriptor.parentId !== undefined) {
    if (config.collapse) {
      parentField = rootCtx.jitFields[descriptor.parentId] ?? null
    } else {
      const parentPath = path.slice(0, -1)
      while (typeof parentPath.at(-1) === 'number') parentPath.pop()
      parentField = rootCtx.jitFieldsByPath.get(`${descriptor.parentId}:${parentPath.join('.')}`) ?? null
    }
  }
  const span = rootCtx.plugin.startResolveSpan(field, rootCtx, executeSpan, startTime, parentField)

  /**
   * @param {unknown} error
   * @param {unknown} result
   */
  const finishField = (error, result) => {
    const endTime = executeSpan._getTime()
    rootCtx.plugin.finishResolveSpan(span, field, error, result, endTime || startTime)
  }
  return callInAsyncScope(resolve, self, callArguments, rootCtx.abortController, field.currentStore, finishField)
}

/**
 * @param {object} rootCtx
 * @param {number} descriptorId
 * @param {unknown} source
 * @param {(string | number)[] | undefined} path
 * @returns {unknown}
 */
function resolveJitDefault (rootCtx, descriptorId, source, path) {
  const descriptor = rootCtx.jitPlan.fields[descriptorId]
  const pathString = path ? path.join('.') : descriptor.collapsedPath
  const fieldKey = `${descriptorId}:${pathString}`
  const field = {
    fieldNode: descriptor.fieldNode,
    fieldName: descriptor.fieldName,
    parentTypeName: descriptor.parentTypeName,
    returnType: descriptor.returnType,
    baseTypeName: descriptor.baseTypeName,
    variableValues: rootCtx.variableValues,
    args: undefined,
    infoPath: undefined,
    pathString,
    collapsedKey: pathString,
    span: null,
    parentStore: null,
    currentStore: null,
  }
  if (rootCtx.config.collapse) {
    rootCtx.jitFields[descriptorId] = field
  } else {
    rootCtx.jitFieldsByPath.set(fieldKey, field)
  }

  const executeSpan = rootCtx.executeSpan
  const startTime = executeSpan._getTime()
  let parentField = null
  if (descriptor.parentId !== undefined) {
    if (rootCtx.config.collapse) {
      parentField = rootCtx.jitFields[descriptor.parentId] ?? null
    } else {
      const parentPath = path.slice(0, -1)
      while (typeof parentPath.at(-1) === 'number') parentPath.pop()
      parentField = rootCtx.jitFieldsByPath.get(`${descriptor.parentId}:${parentPath.join('.')}`) ?? null
    }
  }
  const span = rootCtx.plugin.startResolveSpan(field, rootCtx, executeSpan, startTime, parentField)

  let result
  try {
    result = legacyStorage.run(field.currentStore, () => source?.[descriptor.fieldName])
  } catch (error) {
    const endTime = executeSpan._getTime()
    rootCtx.plugin.finishResolveSpan(span, field, error, undefined, endTime || startTime)
    throw error
  }

  if (typeof result?.then === 'function') {
    return result.then(
      /**
       * @param {unknown} value
       * @returns {unknown}
       */
      (value) => {
        const endTime = executeSpan._getTime()
        rootCtx.plugin.finishResolveSpan(span, field, undefined, value, endTime || startTime)
        return value
      },
      /**
       * @param {unknown} error
       * @throws {unknown}
       */
      (error) => {
        const endTime = executeSpan._getTime()
        rootCtx.plugin.finishResolveSpan(span, field, error, undefined, endTime || startTime)
        throw error
      }
    )
  }

  const endTime = executeSpan._getTime()
  rootCtx.plugin.finishResolveSpan(span, field, undefined, result, endTime || startTime)
  return result
}

/**
 * @param {object} rootCtx
 * @param {number} descriptorId
 * @param {unknown} source
 * @param {(string | number)[] | undefined} path
 * @returns {unknown}
 */
function resolveJitDefaultInvocation (rootCtx, descriptorId, source, path) {
  const descriptor = rootCtx.jitPlan.fields[descriptorId]
  const pathString = path ? path.join('.') : descriptor.collapsedPath
  if (rootCtx.hasIastSub || rootCtx.hasResolverSub) {
    const args = {}
    const info = {
      fieldName: descriptor.fieldName,
      fieldNodes: [descriptor.fieldNode],
    }
    if (rootCtx.hasIastSub) {
      iastResolveCh.publish({
        rootCtx,
        args,
        info,
        path: path ?? descriptor.collapsedPath.split('.'),
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
  }

  const depth = rootCtx.config.countListIndices ? descriptor.pathDepth : descriptor.selectionDepth
  if (depthDisabled || (rootCtx.config.depth >= 0 && rootCtx.config.depth < depth)) {
    if (rootCtx.config.collapse) rootCtx.jitFields[descriptorId] = false
    return source?.[descriptor.fieldName]
  }

  const field = rootCtx.config.collapse
    ? rootCtx.jitFields[descriptorId]
    : rootCtx.jitFieldsByPath.get(`${descriptorId}:${pathString}`)
  if (field === undefined) {
    return resolveJitDefault(rootCtx, descriptorId, source, path)
  }
  return source?.[descriptor.fieldName]
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

// Runs the resolver inside `store`, including any code after an internal
// `await`. A `.then()` the caller attaches afterward runs outside `store`.
function callInAsyncScope (fn, thisArg, args, abortController, store, cb) {
  if (abortController?.signal.aborted) {
    cb(null, null)
    throw new AbortError('Aborted')
  }

  try {
    const result = legacyStorage.run(store, () => fn.apply(thisArg, args))
    if (typeof result?.then === 'function') {
      return result.then(
        res => { cb(null, res); return res },
        err => { cb(err); throw err }
      )
    }
    cb(null, result)
    return result
  } catch (err) {
    cb(err)
    throw err
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
    const fieldKey = rootCtx.config.collapse ? rootCtx.pathCache.get(curr) : curr
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
      if (directive.arguments.length === 0) continue

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

// Unwrap GraphQL List/NonNull wrappers to get the underlying named type's name.
// e.g. [Human] → 'Human', [Pet!] → 'Pet', String → 'String'
function getBaseTypeName (type) {
  let cursor = type
  while (cursor && cursor.ofType) cursor = cursor.ofType
  return cursor?.name
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
module.exports.wrapJitResolve = wrapJitResolve
module.exports.resolveJitDefault = resolveJitDefault
module.exports.resolveJitDefaultInvocation = resolveJitDefaultInvocation
