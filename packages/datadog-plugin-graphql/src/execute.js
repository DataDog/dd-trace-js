'use strict'

const { AsyncLocalStorage } = require('node:async_hooks')
const dc = require('dc-polyfill')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const GraphQLParsePlugin = require('./parse')
const { extractErrorIntoSpanEvent } = require('./utils')

let tools

const types = new Set(['query', 'mutation', 'subscription'])

// Exit-hatch channels kept as synchronous publishes for downstream subscribers
// that need to observe resolvers before/as they run:
// - iastResolveCh: IAST mutates the resolver args object for taint tracking;
//   must fire synchronously before the resolver body runs.
// - resolverStartCh: AppSec receives the abort controller + resolverInfo.
// Both are gated by hasSubscribers so APM-only runs pay zero cost for them.
const iastResolveCh = dc.channel('apm:graphql:resolve:start')
const resolverStartCh = dc.channel('datadog:graphql:resolver:start')

// contexts: contextValue -> rootCtx. Holds per-execute tracing state so the wrapped
// resolvers can look up the active execute context without walking any stack.
// Also serves as the re-entrance short-circuit (master's contexts.has pattern):
// when yoga's normalizedExecutor internally calls execute, the inner call sees
// this map already populated and skips the whole setup.
const contexts = new WeakMap()

// ALS fallback for non-WeakMap-keyable contextValues (primitives, Symbols on Node 18).
// set via enterWith() in bindStart; read via getStore() in resolveAsync.
const primitiveContextAls = new AsyncLocalStorage()

// WeakSet caches: wrap each resolver and each type at most once across the process.
// Critical for recursive types (Human.friends: [Human]) — without patchedTypes the
// schema walk would stack-overflow.
const patchedResolvers = new WeakSet()
const patchedTypes = new WeakSet()

// Module-level fast path for the depth=0 variant: lets resolveAsync skip the
// WeakMap lookup entirely when resolver instrumentation is disabled. Mirrors
// master's startResolveCh.hasSubscribers gating shape — a single property read
// before bailing. Maintained by GraphQLExecutePlugin.configure().
let _depthDisabled = false

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

  configure (config) {
    super.configure(config)
    _depthDisabled = config && config.depth === 0
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
    // Normalize ctx.arguments into a shape we can read. Mutations applied below go
    // directly on ctx.arguments so graphql.execute receives the wrapped resolver.
    const args = readArgs(ctx.arguments)

    // Re-entrant execute() short-circuit: yoga's normalizedExecutor calls execute
    // internally; the inner call shares the same contextValue and would otherwise
    // double-span. This also covers any user-level recursive execute pattern.
    const contextValue = args.contextValue
    if (contextValue && typeof contextValue === 'object' && contexts.has(contextValue)) {
      ctx._ddSkipped = true
      return ctx.currentStore
    }

    const document = args.document
    const docSource = document ? GraphQLParsePlugin.documentSources.get(document) : undefined
    const operation = getOperation(document, args.operationName)

    const type = operation?.operation
    const name = operation?.name?.value
    const source = this.config.source && document && docSource

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

    ctx._ddArgs = args

    // Wrap the default field resolver + walk the schema to wrap explicit field
    // resolvers. Done ONCE per execute (patchedResolvers/patchedTypes WeakSets
    // make this idempotent across calls that share a schema).
    setWrappedFieldResolver(ctx.arguments, defaultFieldResolver)

    const schema = args.schema
    if (schema) {
      wrapFields(schema._queryType)
      wrapFields(schema._mutationType)
      wrapFields(schema._subscriptionType)
    }

    // Register execute context so wrapped resolvers can find their rootCtx.
    // contextValue is used as-is — we never mutate the caller's args.
    // WeakMap requires an object or function key (Node.js 18 doesn't allow
    // Symbols; Node.js 20+ does but we target 18). For non-keyable values
    // (primitives, Symbols on Node 18) we skip the WeakMap; resolvers will
    // run without tracing rather than crashing.
    const cv = args.contextValue
    const rootCtx = {
      // Raw document source text, used by:
      //  (a) the graphql.source span tag on resolve spans (when this.config.source
      //      is enabled), and
      //  (b) the IAST taint-tracking subscriber, which looks up tainted ranges
      //      against this source string to detect hardcoded-literal injection.
      source: docSource,
      config: this.config,
      fields: new Map(),
      abortController: new AbortController(),
      executeSpan: span,
      plugin: this,
    }
    ctx._ddRootCtx = rootCtx
    if (isWeakMapKey(cv)) {
      contexts.set(cv, rootCtx)
      ctx._ddContextValue = cv
    } else {
      // Primitive / non-keyable: store rootCtx in ALS so wrapped resolvers
      // (which receive the original contextValue) can still find it.
      primitiveContextAls.enterWith(rootCtx)
    }

    return ctx.currentStore
  }

  end (ctx) {
    if (ctx._ddSkipped) return ctx.parentStore

    const span = ctx?.currentStore?.span || this.activeSpan
    if (!span) return

    // Synchronous error (e.g., execute(null, doc) throws).
    // The error handler already tagged the span; just finish it.
    if (ctx.error) {
      this._drain(ctx, span)
      return ctx.parentStore
    }

    const result = ctx.result

    // execute() can return a Promise (async execution) or a plain result.
    if (result && typeof result.then === 'function') {
      result.then(
        (res) => this._finishSpan(ctx, span, res),
        (err) => {
          span.setTag('error', err)
          this._drain(ctx, span)
        }
      )
    } else {
      this._finishSpan(ctx, span, result)
    }

    return ctx.parentStore
  }

  error (ctx) {
    const span = ctx?.currentStore?.span || this.activeSpan
    if (span && ctx?.error) {
      span.setTag('error', ctx.error)
    }
  }

  _finishSpan (ctx, span, res) {
    const args = ctx._ddArgs

    this.config.hooks.execute(span, args, res)

    if (res?.errors?.length) {
      span.setTag('error', res.errors[0])
      for (const err of res.errors) {
        extractErrorIntoSpanEvent(this._tracerConfig, span, err)
      }
    }

    this._drain(ctx, span)
  }

  // Finish the execute span and clear the contexts entry. Resolve spans are
  // created and finished inline during resolver execution (see resolveAsync),
  // so no batch-materialize pass is needed here.
  _drain (ctx, span) {
    span.finish()
    if (ctx._ddContextValue) {
      contexts.delete(ctx._ddContextValue)
    }
  }

  // Synchronous span creation at first-encounter. Builds the span with its
  // start time + meta tags and returns it; finishing happens later from the
  // resolver's then-callback via _finishResolveSpan. Inlining span creation
  // (vs deferring all spans to a post-execute batch) keeps encoder buffers
  // hot when each span finishes — in benchmarks the batch pattern produced a
  // bursty encoding stall on collapse-off.
  _startResolveSpan (field, rootCtx, executeSpan, startTime) {
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

  // Apply error/hook tags and finish the span. Called from the resolver's
  // then-callback, so endTime reflects when the resolver actually completed.
  _finishResolveSpan (span, field, error, result, endTime) {
    if (error) span.setTag('error', error)

    if (this.config.hooks.resolve) {
      this.config.hooks.resolve(span, {
        fieldName: field.fieldName,
        path: field.pathString,
        error: error || null,
        result: result instanceof Promise ? undefined : result,
      })
    }

    span.finish(endTime)
  }
}

// --- resolver wrapping --------------------------------------------------------

function wrapResolve (resolve) {
  if (typeof resolve !== 'function' || patchedResolvers.has(resolve)) return resolve

  function resolveAsync (source, args, contextValue, info) {
    // Fast-path: when resolver instrumentation is disabled (depth=0) skip the
    // WeakMap lookup and any path computation. Single property read, matches
    // the cost of master's startResolveCh.hasSubscribers gate.
    if (_depthDisabled) return resolve.apply(this, arguments)

    const rootCtx = contexts.get(contextValue) ?? primitiveContextAls.getStore()
    if (!rootCtx) return resolve.apply(this, arguments)

    const infoPath = info?.path
    const config = rootCtx.config

    // Depth check directly on the linked-list — no array allocation needed.
    // Moved before the Map lookup so depth-filtered resolvers bail immediately.
    if (!shouldInstrumentNode(config, infoPath)) return resolve.apply(this, arguments)

    // Map key strategy:
    //   non-collapse → path node object reference (O(1) identity lookup, no string)
    //   collapse     → collapsed path string (deduplicates array siblings automatically)
    let mapKey, collapsedKey
    if (config.collapse) {
      collapsedKey = buildCollapsedPathStringFromNode(infoPath)
      mapKey = collapsedKey
    } else {
      mapKey = infoPath
    }

    // Record field on first-encounter. For collapsed mode, subsequent invocations
    // of the same collapsed path key find the existing entry and run through
    // without overwriting its timing (first resolver's timing represents the group).
    let field = rootCtx.fields.get(mapKey)
    const isFirst = !field

    if (isFirst) {
      // Compute path string lazily — only on the first encounter per field entry.
      const pathString = config.collapse ? collapsedKey : buildPathStringFromNode(infoPath)
      if (!collapsedKey) collapsedKey = pathString

      // Store only the scalars we actually use later; avoids retaining the full
      // GraphQLResolveInfo object (which holds schema refs, variable maps, etc.).
      field = {
        fieldNode: info.fieldNodes?.[0],
        fieldName: info.fieldName,
        returnType: info.returnType,
        baseTypeName: getBaseTypeName(info.returnType),
        variableValues: info.variableValues,
        args,
        infoPath,
        pathString,
        collapsedKey,
        span: null,
      }
      rootCtx.fields.set(mapKey, field)
    }

    // IAST exit hatch — IAST mutates `args` for taint tracking. Fires sync
    // before the resolver body runs so taint propagates into user code.
    // pathToArray is kept here (IAST needs the array form) but gated so APM-only
    // runs pay zero cost.
    if (iastResolveCh.hasSubscribers) {
      const pathArr = pathToArray(infoPath)
      iastResolveCh.publish({ rootCtx, args, info, path: pathArr, pathString: field.pathString })
    }

    // AppSec exit hatch.
    if (resolverStartCh.hasSubscribers) {
      resolverStartCh.publish({
        abortController: rootCtx.abortController,
        resolverInfo: getResolverInfo(info, args),
      })
    }

    // Collapsed duplicates run the original resolver without capturing timing.
    if (!isFirst) return resolve.apply(this, arguments)

    // Use the execute span's clock so the recorded Unix-ms timestamps line up
    // with the trace's reference; performance.now() alone would be ~0 since
    // process start and produce malformed span timestamps.
    const executeSpan = rootCtx.executeSpan
    const startTime = executeSpan._getTime ? executeSpan._getTime() : undefined
    // Inline span creation: parents are recorded before children (graphql
    // resolves a parent fully before its children), so getParentField finds
    // the parent's span here.
    const span = rootCtx.plugin._startResolveSpan(field, rootCtx, executeSpan, startTime)
    field.span = span

    return callInAsyncScope(resolve, this, arguments, rootCtx.abortController, (err, res) => {
      const endTime = executeSpan._getTime ? executeSpan._getTime() : undefined
      rootCtx.plugin._finishResolveSpan(span, field, err, res, endTime || startTime)
    })
  }

  patchedResolvers.add(resolveAsync)
  return resolveAsync
}

function wrapFields (type) {
  if (!type || !type._fields || patchedTypes.has(type)) return

  patchedTypes.add(type)

  for (const field of Object.values(type._fields)) {
    wrapFieldResolve(field)
    wrapFieldType(field)
  }
}

function wrapFieldResolve (field) {
  if (!field || !field.resolve) return
  field.resolve = wrapResolve(field.resolve)
}

function wrapFieldType (field) {
  if (!field || !field.type) return

  let unwrapped = field.type
  while (unwrapped.ofType) unwrapped = unwrapped.ofType

  wrapFields(unwrapped)
}

function callInAsyncScope (fn, thisArg, args, abortController, cb) {
  cb = cb || (() => {})

  if (abortController?.signal.aborted) {
    cb(null, null)
    throw new AbortError('Aborted')
  }

  try {
    const result = fn.apply(thisArg, args)
    if (result && typeof result.then === 'function') {
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

// Build a plain path string from a graphql linked-list Path node (root→leaf).
// Used on first-encounter for non-collapsed fields. Avoids pathToArray + join
// so the intermediate array is never allocated.
function buildPathStringFromNode (path) {
  let length = 0
  for (let curr = path; curr; curr = curr.prev) length++
  const segments = new Array(length)
  let i = length
  for (let curr = path; curr; curr = curr.prev) segments[--i] = curr.key
  return segments.join('.')
}

// Build a collapsed path string from a linked-list node, replacing number
// segments with '*' (array indices collapse to a single representative slot).
function buildCollapsedPathStringFromNode (path) {
  let length = 0
  for (let curr = path; curr; curr = curr.prev) length++
  const segments = new Array(length)
  let i = length
  for (let curr = path; curr; curr = curr.prev) {
    segments[--i] = typeof curr.key === 'number' ? '*' : curr.key
  }
  return segments.join('.')
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

// Walk up the path to find the nearest recorded ancestor field (for span parenting).
// Non-collapse: traverse the linked-list prev chain, each node is a unique Map key.
// Collapse: strip the last dotted segment of the collapsed key string, Map key is string.
function getParentField (rootCtx, field) {
  if (!rootCtx.config.collapse) {
    for (let curr = field.infoPath?.prev; curr; curr = curr.prev) {
      const f = rootCtx.fields.get(curr)
      if (f) return f
    }
    return null
  }

  let current = field.collapsedKey
  while (current) {
    const last = current.lastIndexOf('.')
    if (last === -1) break
    current = current.slice(0, last)
    const f = rootCtx.fields.get(current)
    if (f) return f
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

function readArgs (args) {
  if (!args || args.length === 0) return {}

  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
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

// Set a wrapped fieldResolver on the underlying arguments array so graphql.execute
// uses our wrapped default resolver. Works for both v16 (single-object) and v15
// (positional) call signatures.
//
// Constraints:
//   - frozen/sealed args objects must not be modified (would throw TypeError)
//   - caller-supplied fieldResolver must not be overwritten in-place
function setWrappedFieldResolver (rawArgs, defaultFieldResolver) {
  if (!rawArgs || rawArgs.length === 0) return

  if (rawArgs.length === 1 && rawArgs[0] && typeof rawArgs[0] === 'object' && !Array.isArray(rawArgs[0])) {
    const argsObj = rawArgs[0]
    if (!Object.isExtensible(argsObj)) return
    if (!Object.hasOwn(argsObj, 'fieldResolver')) {
      argsObj.fieldResolver = wrapResolve(defaultFieldResolver)
    }
    return
  }

  // Positional call: only inject if caller omitted fieldResolver.
  if (rawArgs[6] == null) {
    rawArgs[6] = wrapResolve(defaultFieldResolver)
    if (rawArgs.length < 7) rawArgs.length = 7
  }
}

function isWeakMapKey (value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

// Unwrap GraphQL List/NonNull wrappers to get the underlying named type's name.
// e.g. [Human] → 'Human', [Pet!] → 'Pet', String → 'String'
function getBaseTypeName (type) {
  let t = type
  while (t && t.ofType) t = t.ofType
  return t?.name
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

function getSignature (document, operationName, operationType, calculate) {
  if (calculate !== false && tools !== false) {
    try {
      try {
        tools = tools || require('./tools')
      } catch (e) {
        tools = false
        throw e
      }

      return tools.defaultEngineReportingSignature(document, operationName)
    } catch {
      // safety net
    }
  }

  return [operationType, operationName].filter(Boolean).join(' ')
}

module.exports = GraphQLExecutePlugin
