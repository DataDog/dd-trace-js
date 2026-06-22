'use strict'

const dc = require('dc-polyfill')

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const GraphQLParsePlugin = require('./parse')
const { extractErrorIntoSpanEvent, getSignature } = require('./utils')

const legacyStorage = storage('legacy')

const types = new Set(['query', 'mutation', 'subscription'])

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

const patchedResolvers = new WeakSet()
const patchedTypes = new WeakSet()

// Module-level fast path: skip the resolver-side WeakMap lookup entirely
// when depth=0 disables resolver instrumentation.
let depthDisabled = false

class AbortError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AbortError'
  }
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

  bindStart (ctx) {
    const args = readArgs(ctx.arguments)

    // Re-entrant execute() short-circuit (yoga's normalizedExecutor calls
    // execute internally with the same contextValue — without this we'd
    // double-span).
    const { contextValue } = args
    if (contextValue && typeof contextValue === 'object' && contexts.has(contextValue)) {
      ctx.ddSkipped = true
      return ctx.currentStore
    }

    const document = args.document
    const docSource = document ? GraphQLParsePlugin.documentSources.get(document) : undefined
    const operation = getOperation(document, args.operationName)

    const type = operation?.operation
    const name = operation?.name?.value
    const source = this.config.source && docSource

    ctx.collapse = this.config.collapse

    const span = this.startSpan(this.operationName(), {
      service: this.config.service || this.serviceName(),
      resource: getSignature(document, name, type, this.config.signature),
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
        // Replace ctx.arguments[0] with a Proxy that throws AbortError on any
        // property access. The orchestrion wrapper calls
        // `__apm$wrapped.apply(this, ctx.arguments)`; graphql.execute's body
        // begins with `const { schema, document, ... } = args` so the
        // destructure triggers the trap immediately. The wrapper catches and
        // rethrows, propagating AbortError to graphql.execute's caller.
        ctx.arguments[0] = new Proxy({}, {
          get () { throw new AbortError('Aborted') },
          has () { throw new AbortError('Aborted') },
        })
        ctx.ddAborted = true
        return ctx.currentStore
      }
    }

    ctx.ddArgs = setWrappedFieldResolver(ctx.arguments, defaultFieldResolver)

    const schema = args.schema
    if (schema) {
      wrapFields(schema._queryType)
      wrapFields(schema._mutationType)
      wrapFields(schema._subscriptionType)
    }

    const rootCtx = {
      source: docSource,
      config: this.config,
      fields: new Map(),
      pathCache: new Map(),
      abortController,
      executeSpan: span,
      plugin: this,
    }
    ctx.ddRootCtx = rootCtx
    if (isWeakMapKey(contextValue)) {
      contexts.set(contextValue, rootCtx)
      ctx.ddContextValue = contextValue
    } else {
      // Primitive / non-keyable contextValue: stash rootCtx on the
      // orchestrion-scoped store that runStores enters for execute. Wrapped
      // resolvers read it via legacyStorage.getStore() and it unwinds with the
      // frame — no enterWith store that leaks past execute.
      ctx.currentStore.graphqlRootCtx = rootCtx
    }

    return ctx.currentStore
  }

  end (ctx) {
    if (ctx.ddSkipped) return ctx.parentStore

    const span = ctx?.currentStore?.span || this.activeSpan
    if (!span) return

    // Synchronous execute() throw (e.g. execute(null, doc)) — error handler
    // already tagged the span, just finish it.
    if (ctx.error) {
      this.#drain(ctx, span)
      return ctx.parentStore
    }

    const result = ctx.result

    if (typeof result?.then === 'function') {
      result.then(
        (res) => this.#finishSpan(ctx, span, res),
        (err) => {
          span.setTag('error', err)
          this.#drain(ctx, span)
        }
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

  #finishSpan (ctx, span, res) {
    this.config.hooks.execute(span, ctx.ddArgs, res)

    if (res?.errors?.length) {
      span.setTag('error', res.errors[0])
      for (const err of res.errors) {
        extractErrorIntoSpanEvent(this._tracerConfig, span, err)
      }
    }

    this.#drain(ctx, span)
  }

  #drain (ctx, span) {
    span.finish()
    if (ctx.ddContextValue) {
      contexts.delete(ctx.ddContextValue)
    }
  }

  // Public — called from wrapResolve (free function, crosses class boundary).
  // Resolve-span creation is inline at first-encounter; deferring to a batch
  // produces a bursty encoder stall when many spans finish together.
  startResolveSpan (field, rootCtx, executeSpan, startTime) {
    const { fieldNode, fieldName, returnType, baseTypeName, variableValues, collapsedKey } = field

    const parent = getParentField(rootCtx, field)
    const childOf = parent?.span || executeSpan

    const document = rootCtx.source
    const loc = this.config.source && document && fieldNode && fieldNode.loc
    const source = loc && document.slice(loc.start, loc.end)

    const span = this.startSpan('graphql.resolve', {
      service: this.config.service,
      resource: `${fieldName}:${returnType}`,
      childOf,
      type: 'graphql',
      startTime,
      meta: {
        'graphql.field.name': fieldName,
        'graphql.field.path': collapsedKey,
        'graphql.field.type': baseTypeName,
        'graphql.source': source,
      },
    }, false)

    if (fieldNode && this.config.variables && fieldNode.arguments) {
      const variables = this.config.variables(variableValues)
      for (const arg of fieldNode.arguments) {
        if (arg.value?.name && arg.value.kind === 'Variable' && variables[arg.value.name.value]) {
          const name = arg.value.name.value
          span.setTag(`graphql.variables.${name}`, variables[name])
        }
      }
    }

    return span
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

function wrapResolve (resolve) {
  if (typeof resolve !== 'function' || patchedResolvers.has(resolve)) return resolve

  function resolveAsync (source, args, contextValue, info) {
    const hasIastSub = iastResolveCh.hasSubscribers
    const hasResolverSub = resolverStartCh.hasSubscribers

    // Combined fast-path: depth=0 AND no IAST/AppSec subscriber means nothing
    // to do — skip rootCtx lookup, path walk, publish gates.
    if (depthDisabled && !hasIastSub && !hasResolverSub) {
      return resolve.apply(this, arguments)
    }

    const rootCtx = contexts.get(contextValue) ?? legacyStorage.getStore()?.graphqlRootCtx
    if (!rootCtx) return resolve.apply(this, arguments)

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
      return resolve.apply(this, arguments)
    }

    const mapKey = config.collapse ? collapsedKey : infoPath
    let field = rootCtx.fields.get(mapKey)
    const isFirst = !field

    if (isFirst) {
      field = {
        fieldNode: info.fieldNodes?.[0],
        fieldName: info.fieldName,
        returnType: info.returnType,
        baseTypeName: getBaseTypeName(info.returnType),
        variableValues: info.variableValues,
        args,
        infoPath,
        pathString,
        collapsedKey: collapsedKey ?? pathString,
        span: null,
      }
      rootCtx.fields.set(mapKey, field)
    }

    // Collapsed siblings still publish updateField (master's contract: one
    // publish per resolver call, even when the span is collapsed) and route
    // through callInAsyncScope so the abort signal stops them mid-flight.
    if (!isFirst) {
      return callInAsyncScope(resolve, this, arguments, rootCtx.abortController, (err) => {
        if (updateFieldCh.hasSubscribers) {
          updateFieldCh.publish({ rootCtx, field, error: err, pathString: field.pathString })
        }
      })
    }

    const executeSpan = rootCtx.executeSpan
    const startTime = executeSpan._getTime()
    const span = rootCtx.plugin.startResolveSpan(field, rootCtx, executeSpan, startTime)
    field.span = span

    return callInAsyncScope(resolve, this, arguments, rootCtx.abortController, (err, res) => {
      const endTime = executeSpan._getTime()
      rootCtx.plugin.finishResolveSpan(span, field, err, res, endTime || startTime)
      if (updateFieldCh.hasSubscribers) {
        updateFieldCh.publish({ rootCtx, field, error: err, pathString: field.pathString })
      }
    })
  }

  patchedResolvers.add(resolveAsync)
  return resolveAsync
}

function wrapFields (type) {
  if (!type?._fields || patchedTypes.has(type)) return

  patchedTypes.add(type)

  for (const field of Object.values(type._fields)) {
    wrapFieldResolve(field)
    wrapFieldType(field)
  }
}

function wrapFieldResolve (field) {
  if (!field?.resolve) return
  field.resolve = wrapResolve(field.resolve)
}

function wrapFieldType (field) {
  if (!field?.type) return

  let unwrapped = field.type
  while (unwrapped.ofType) unwrapped = unwrapped.ofType

  wrapFields(unwrapped)
}

function callInAsyncScope (fn, thisArg, args, abortController, cb) {
  cb ??= () => {}

  if (abortController?.signal.aborted) {
    cb(null, null)
    throw new AbortError('Aborted')
  }

  try {
    const result = fn.apply(thisArg, args)
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

// Depth filtering directly on the linked-list node — no array allocation needed.
// config.depth < 0 means no limit. In non-collapse mode only string segments
// count toward depth (array indices are transparent). In collapse mode every
// node counts (numbers have been conceptually '*'-collapsed).
function shouldInstrumentNode (config, path) {
  if (config.depth < 0) return true

  let depth = 0
  if (config.collapse) {
    for (let curr = path; curr; curr = curr.prev) depth++
  } else {
    for (let curr = path; curr; curr = curr.prev) {
      if (typeof curr.key === 'string') depth++
    }
  }

  return config.depth >= depth
}

function getParentField (rootCtx, field) {
  if (!rootCtx.config.collapse) {
    for (let curr = field.infoPath?.prev; curr; curr = curr.prev) {
      const innerField = rootCtx.fields.get(curr)
      if (innerField) return innerField
    }
    return null
  }

  let current = field.collapsedKey
  while (current) {
    const last = current.lastIndexOf('.')
    if (last === -1) break
    current = current.slice(0, last)
    const innerField = rootCtx.fields.get(current)
    if (innerField) return innerField
  }
  return null
}

// Build the resolverInfo payload that AppSec's datadog:graphql:resolver:start
// subscriber expects: { [fieldName]: { ...args, ...directives } }.
function getResolverInfo (info, args) {
  let resolverVars

  if (args && Object.keys(args).length > 0) {
    resolverVars = { ...args }
  }

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
  return args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
}

function readArgs (args) {
  if (!args || args.length === 0) return {}

  if (isObjectForm(args)) {
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
function setWrappedFieldResolver (rawArgs, defaultFieldResolver) {
  if (!rawArgs || rawArgs.length === 0) return {}

  if (isObjectForm(rawArgs)) {
    const original = rawArgs[0]
    const clone = {
      ...original,
      fieldResolver: wrapResolve(original.fieldResolver || defaultFieldResolver),
    }
    rawArgs[0] = clone
    return clone
  }

  rawArgs[6] = wrapResolve(rawArgs[6] || defaultFieldResolver)
  if (rawArgs.length < 7) rawArgs.length = 7
  return {
    schema: rawArgs[0],
    document: rawArgs[1],
    rootValue: rawArgs[2],
    contextValue: rawArgs[3],
    variableValues: rawArgs[4],
    operationName: rawArgs[5],
    fieldResolver: rawArgs[6],
  }
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
  if (source == null) return
  const property = source[info.fieldName]
  if (typeof property === 'function') return source[info.fieldName](args, contextValue, info)
  return property
}

function getOperation (document, operationName) {
  if (!document || !Array.isArray(document.definitions)) return

  for (const definition of document.definitions) {
    if (definition && types.has(definition.operation) &&
        (!operationName || definition.name?.value === operationName)) {
      return definition
    }
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
