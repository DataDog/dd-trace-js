'use strict'

const dc = require('dc-polyfill')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const GraphQLParsePlugin = require('./parse')
const { extractErrorIntoSpanEvent } = require('./utils')

let tools

const types = new Set(['query', 'mutation', 'subscription'])

// Resolve-path channels. Published from the wrapped resolver (wrapResolve below)
// and consumed by the graphql.resolve plugin in resolve.js.
const startResolveCh = dc.channel('apm:graphql:resolve:start')
const finishResolveCh = dc.channel('apm:graphql:resolve:finish')
const updateFieldCh = dc.channel('apm:graphql:resolve:updateField')
const resolveErrorCh = dc.channel('apm:graphql:resolve:error')

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
      source,
      fields: Object.create(null),
      abortController: new AbortController(),
      executeSpan: span,
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

  // Publish finish for all tracked resolve spans (the resolve plugin listens and
  // calls span.finish), then finish the execute span, then clear the contexts entry.
  _drain (ctx, span) {
    const rootCtx = ctx._ddRootCtx
    if (rootCtx && finishResolveCh.hasSubscribers) {
      finishResolvers(rootCtx)
    }
    span.finish()
    if (ctx._ddContextValue) {
      contexts.delete(ctx._ddContextValue)
    }
  }
}

// --- resolver wrapping --------------------------------------------------------

function wrapResolve (resolve) {
  if (typeof resolve !== 'function' || patchedResolvers.has(resolve)) return resolve

  function resolveAsync (source, args, contextValue, info) {
    // Fast path: no subscribers means no span will be created. Call through.
    if (!startResolveCh.hasSubscribers) return resolve.apply(this, arguments)

    const rootCtx = contexts.get(contextValue)
    if (!rootCtx) return resolve.apply(this, arguments)

    const field = assertField(rootCtx, info, args)

    return callInAsyncScope(resolve, this, arguments, rootCtx.abortController, (err, res) => {
      field.ctx.error = err
      field.ctx.info = info
      field.ctx.field = field
      field.ctx.result = res
      updateFieldCh.publish(field.ctx)
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

function assertField (rootCtx, info, args) {
  const path = pathToArray(info?.path)
  const pathString = path.join('.')
  const fields = rootCtx.fields

  let field = fields[pathString]
  if (!field) {
    const fieldCtx = { info, rootCtx, args, path, pathString }
    startResolveCh.publish(fieldCtx)
    field = fields[pathString] = { error: null, ctx: fieldCtx }
  }
  return field
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

// Publish finish (and error, when applicable) events for every tracked field.
// Iterated in reverse insertion order so parent spans close after their children.
function finishResolvers (rootCtx) {
  const fields = rootCtx.fields
  const keys = Object.keys(fields)
  for (let i = keys.length - 1; i >= 0; i--) {
    const field = fields[keys[i]]
    field.ctx.finishTime = field.finishTime
    field.ctx.field = field
    if (field.error && resolveErrorCh.hasSubscribers) {
      field.ctx.error = field.error
      resolveErrorCh.publish(field.ctx)
    }
    finishResolveCh.publish(field.ctx)
  }
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
