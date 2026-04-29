'use strict'

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

// WeakSet caches: wrap each resolver and each type at most once across the process.
// Critical for recursive types (Human.friends: [Human]) — without patchedTypes the
// schema walk would stack-overflow.
const patchedResolvers = new WeakSet()
const patchedTypes = new WeakSet()

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
    const defaultFieldResolver = getDefaultFieldResolver()
    setWrappedFieldResolver(ctx.arguments, defaultFieldResolver)

    const schema = args.schema
    if (schema) {
      wrapFields(schema._queryType)
      wrapFields(schema._mutationType)
      wrapFields(schema._subscriptionType)
    }

    // Register execute context so the wrapped resolvers can find their rootCtx.
    // Normalize contextValue to an object for WeakMap keying (matches master).
    const cv = normalizeContextValue(ctx.arguments)
    const rootCtx = {
      // Raw document source text, used by:
      //  (a) the graphql.source span tag on resolve spans (when this.config.source
      //      is enabled), and
      //  (b) the IAST taint-tracking subscriber, which looks up tainted ranges
      //      against this source string to detect hardcoded-literal injection.
      source: docSource,
      config: this.config,
      fields: Object.create(null),
      abortController: new AbortController(),
      executeSpan: span,
      plugin: this,
    }
    contexts.set(cv, rootCtx)
    ctx._ddRootCtx = rootCtx
    ctx._ddContextValue = cv

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
    const { info, collapsedKey } = field

    const parent = getParentField(rootCtx, collapsedKey)
    const childOf = parent?.span || executeSpan

    const document = rootCtx.source
    const fieldNode = info.fieldNodes?.find(fn => fn.kind === 'Field')
    const loc = this.config.source && document && fieldNode && fieldNode.loc
    const source = loc && document.slice(loc.start, loc.end)

    const span = this.startSpan('graphql.resolve', {
      service: this.config.service,
      resource: `${info.fieldName}:${info.returnType}`,
      childOf,
      type: 'graphql',
      startTime,
      meta: {
        'graphql.field.name': info.fieldName,
        'graphql.field.path': collapsedKey,
        'graphql.field.type': info.returnType?.name,
        'graphql.source': source,
      },
    }, false)

    if (fieldNode && this.config.variables && fieldNode.arguments) {
      const variables = this.config.variables(info.variableValues)
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
        fieldName: field.info.fieldName,
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
    const rootCtx = contexts.get(contextValue)
    if (!rootCtx) return resolve.apply(this, arguments)

    const path = pathToArray(info?.path)
    const pathString = path.join('.')
    const collapsedPath = rootCtx.config.collapse ? collapsePath(path) : path
    const collapsedKey = rootCtx.config.collapse ? collapsedPath.join('.') : pathString

    // Depth filter: measured against the effective (collapsed) path, so a
    // collapsed segment like '*' counts toward depth — matches the previous
    // resolve plugin's behavior exactly (e.g. with depth=2, 'friends.*.name'
    // is depth 3 and gets filtered, but 'human.name' is depth 2 and passes).
    if (!shouldInstrument(rootCtx.config, collapsedPath)) return resolve.apply(this, arguments)

    // Record field on first-encounter. For collapsed mode, subsequent invocations
    // of the same collapsed path key find the existing entry and run through
    // without overwriting its timing (first resolver's timing represents the group).
    let field = rootCtx.fields[collapsedKey]
    const isFirst = !field
    if (isFirst) {
      field = rootCtx.fields[collapsedKey] = {
        info, args, path, pathString, collapsedKey, span: null,
      }
    }

    // IAST exit hatch — IAST mutates `args` for taint tracking. Fires sync
    // before the resolver body runs so taint propagates into user code.
    if (iastResolveCh.hasSubscribers) {
      iastResolveCh.publish({ rootCtx, args, info, path: collapsedPath, pathString: collapsedKey })
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

  for (const key of Object.keys(type._fields)) {
    const field = type._fields[key]
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
  const flattened = []
  let curr = path
  while (curr) {
    flattened.push(curr.key)
    curr = curr.prev
  }
  return flattened.reverse()
}

// Collapse array indices in a path array to '*' for the collapsed field key.
function collapsePath (path) {
  return path.map(s => typeof s === 'number' ? '*' : s)
}

// Depth filtering: count only string segments in the path (array indices don't
// count). config.depth < 0 means no limit.
function shouldInstrument (config, path) {
  let depth = 0
  for (const item of path) {
    if (typeof item === 'string') depth += 1
  }
  return config.depth < 0 || config.depth >= depth
}

// Walk up the collapsed path key to find the nearest recorded ancestor field.
// Used for span parent-child nesting.
function getParentField (rootCtx, key) {
  let current = key
  while (current) {
    const last = current.lastIndexOf('.')
    if (last === -1) break
    current = current.slice(0, last)
    const field = rootCtx.fields[current]
    if (field) return field
  }
  return null
}

// Build the resolverInfo payload that AppSec's datadog:graphql:resolver:start
// subscriber expects: { [fieldName]: { ...args, ...directives } }.
function getResolverInfo (info, args) {
  let resolverInfo = null
  const resolverVars = {}

  if (args) Object.assign(resolverVars, args)

  let hasResolvers = false
  const directives = info.fieldNodes?.[0]?.directives
  if (Array.isArray(directives)) {
    for (const directive of directives) {
      const argList = {}
      for (const argument of directive.arguments) {
        argList[argument.name.value] = argument.value.value
      }
      if (directive.arguments.length > 0) {
        hasResolvers = true
        resolverVars[directive.name.value] = argList
      }
    }
  }

  if (hasResolvers || (args && Object.keys(resolverVars).length)) {
    resolverInfo = { [info.fieldName]: resolverVars }
  }

  return resolverInfo
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
function setWrappedFieldResolver (rawArgs, defaultFieldResolver) {
  if (!rawArgs || rawArgs.length === 0) return

  if (rawArgs.length === 1 && rawArgs[0] && typeof rawArgs[0] === 'object' && !Array.isArray(rawArgs[0])) {
    rawArgs[0].fieldResolver = wrapResolve(rawArgs[0].fieldResolver || defaultFieldResolver)
    return
  }

  // Positional call: pad the arguments array if the caller omitted fieldResolver.
  rawArgs[6] = wrapResolve(rawArgs[6] || defaultFieldResolver)
  if (rawArgs.length < 7) rawArgs.length = 7
}

// Ensure contextValue is an object (required for WeakMap keying). Mutates rawArgs
// in-place so graphql and our wrapped resolvers see the same object reference.
function normalizeContextValue (rawArgs) {
  if (rawArgs.length === 1 && rawArgs[0] && typeof rawArgs[0] === 'object' && !Array.isArray(rawArgs[0])) {
    rawArgs[0].contextValue ||= {}
    return rawArgs[0].contextValue
  }

  rawArgs[3] = rawArgs[3] || {}
  return rawArgs[3]
}

// graphql's defaultFieldResolver is captured on ddGlobal by the instrumentations
// module at graphql load time. Read lazily so the execute.js load hook has had
// a chance to run.
function getDefaultFieldResolver () {
  const ddGlobal = globalThis[Symbol.for('dd-trace')]
  return ddGlobal?.graphql_defaultFieldResolver
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
  const tags = {}

  if (variableValues && config.variables) {
    const variables = config.variables(variableValues)
    for (const [param, value] of Object.entries(variables)) {
      tags[`graphql.variables.${param}`] = value
    }
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
