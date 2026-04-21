'use strict'

const dc = require('dc-polyfill')
const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { registerPendingResolveSpan } = require('./state')

const collapsedPathSym = Symbol('collapsedPaths')

// Track fields per execution context for deduplication and parent-child relationships.
// Shared with execute.js so it can finish resolve spans in the same flush.
const execContextFields = new WeakMap()

class GraphQLResolvePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'resolve'
  static prefix = 'tracing:orchestrion:graphql:apm:graphql:resolve'

  constructor (...args) {
    super(...args)

    this.resolverStartCh = dc.channel('datadog:graphql:resolver:start')
    this.iastResolveCh = dc.channel('apm:graphql:resolve:start')
  }

  bindStart (ctx) {
    // executeField/resolveField(exeContext, parentType, source, fieldNodes, path)
    const exeContext = ctx.arguments?.[0]
    const parentType = ctx.arguments?.[1]
    const fieldNodes = ctx.arguments?.[3]
    const path = ctx.arguments?.[4]

    if (!exeContext || !fieldNodes || !fieldNodes[0]) return

    const fieldNode = fieldNodes[0]
    const fieldName = fieldNode.name?.value
    if (!fieldName) return

    // Look up the field definition to get return type
    const fieldDef = getFieldDef(exeContext.schema, parentType, fieldNode)
    if (!fieldDef) return

    const returnType = fieldDef.type

    // Get or create field tracking for this execution
    let rootCtx = execContextFields.get(exeContext)
    if (!rootCtx) {
      // Get source text from the operation's location (available in all graphql versions).
      // exeContext.document does not exist in any version; the source is available via
      // operation.loc.source.body which contains the full GraphQL query text.
      const docSource = exeContext.operation?.loc?.source?.body
      // Capture the execute span from the current store on first resolve call.
      // At this point the store's span is the execute span (not yet any resolve spans).
      const store = storage('legacy').getStore()
      const executeSpan = store?.span
      rootCtx = { fields: Object.create(null), source: docSource, pendingSpans: [], executeSpan }
      execContextFields.set(exeContext, rootCtx)
    }

    // Walk the path linked-list exactly once per field. The un-collapsed array is
    // used as the parent-lookup basis; the (possibly collapsed) computedPath feeds
    // shouldInstrument, the field key, and the span tag.
    const pathArr = pathToArray(path)
    const computedPath = this.config.collapse
      ? pathArr.map(segment => typeof segment === 'number' ? '*' : segment)
      : pathArr

    if (!shouldInstrument(this.config, computedPath)) return

    const computedPathString = computedPath.join('.')

    if (this.config.collapse) {
      if (rootCtx.fields[computedPathString]) return

      if (!rootCtx[collapsedPathSym]) {
        rootCtx[collapsedPathSym] = Object.create(null)
      } else if (rootCtx[collapsedPathSym][computedPathString]) {
        return
      }

      rootCtx[collapsedPathSym][computedPathString] = true
    }

    // Get parent field span for correct nesting. computedPath already matches
    // the collapsed-form field keys, so it doubles as the lookup basis.
    const parentField = getParentField(rootCtx, computedPath)
    const childOf = parentField?.ctx?.currentStore?.span

    const document = rootCtx.source
    const fieldNodeForSource = fieldNodes.find(fn => fn.kind === 'Field')
    const loc = this.config.source && document && fieldNodeForSource && fieldNodeForSource.loc
    const source = loc && document.slice(loc.start, loc.end)

    const span = this.startSpan('graphql.resolve', {
      service: this.config.service,
      resource: `${fieldName}:${returnType}`,
      childOf,
      type: 'graphql',
      meta: {
        'graphql.field.name': fieldName,
        'graphql.field.path': computedPathString,
        'graphql.field.type': returnType.name,
        'graphql.source': source,
      },
    }, ctx)

    if (fieldNodeForSource && this.config.variables && fieldNodeForSource.arguments) {
      const variables = this.config.variables(exeContext.variableValues)

      for (const arg of fieldNodeForSource.arguments) {
        if (arg.value?.name && arg.value.kind === 'Variable' && variables[arg.value.name.value]) {
          const name = arg.value.name.value
          span.setTag(`graphql.variables.${name}`, variables[name])
        }
      }
    }

    // Register this field in the root context for parent lookups
    rootCtx.fields[computedPathString] = {
      error: null,
      ctx,
    }

    // Stash for end handler as a single object: one hidden-class transition on ctx
    // instead of seven, one GC entry to free, one truthiness check to gate end().
    ctx._ddState = {
      fieldName,
      rootCtx,
      computedPathString,
      executeSpan: rootCtx.executeSpan,
      exeContext,
      errorCountBefore: getErrorCount(exeContext),
    }

    // The info-like object and resolver args are only consumed by the AppSec
    // (resolverStartCh) and IAST (iastResolveCh) channels. For the APM-only
    // hot path (no subscribers), skip these allocations entirely.
    const needsSubscriberData = this.resolverStartCh.hasSubscribers ||
      (this.iastResolveCh.hasSubscribers && fieldDef.resolve)

    if (!needsSubscriberData) return ctx.currentStore

    const info = {
      fieldName,
      fieldNodes,
      returnType,
      parentType,
      path,
      schema: exeContext.schema,
      fragments: exeContext.fragments,
      rootValue: exeContext.rootValue,
      operation: exeContext.operation,
      variableValues: exeContext.variableValues,
    }

    if (this.resolverStartCh.hasSubscribers) {
      const resolverArgs = getResolverArgs(fieldDef, fieldNode, exeContext.variableValues)
      const abortController = new AbortController()
      this.resolverStartCh.publish({ abortController, resolverInfo: getResolverInfo(info, resolverArgs) })
    }

    if (this.iastResolveCh.hasSubscribers && fieldDef.resolve) {
      const iastResolveCh = this.iastResolveCh
      const capturedRootCtx = rootCtx
      const capturedPath = computedPath
      const capturedPathString = computedPathString
      const capturedInfo = info
      const originalResolve = fieldDef.resolve

      fieldDef.resolve = function (source, args, contextValue, resolveInfo) {
        fieldDef.resolve = originalResolve
        iastResolveCh.publish({
          rootCtx: capturedRootCtx, args, info: capturedInfo, path: capturedPath, pathString: capturedPathString,
        })
        return originalResolve.call(this, source, args, contextValue, resolveInfo)
      }
    }

    return ctx.currentStore
  }

  end (ctx) {
    const state = ctx._ddState
    if (!state) return

    const span = ctx?.currentStore?.span || this.activeSpan
    if (!span) return

    const { exeContext, errorCountBefore, rootCtx, computedPathString, executeSpan, fieldName } = state

    // Detect resolver errors. executeField/resolveField catch resolver exceptions
    // internally (try-catch in graphql's execute.js), so the traceSync error channel
    // never fires. Instead, detect errors by checking if the error collection grew.
    let resolverError = ctx.error
    if (!resolverError && exeContext) {
      const errorsNow = getErrorCount(exeContext)
      if (errorsNow > errorCountBefore) {
        const gqlError = getErrorAt(exeContext, errorsNow - 1)
        // Unwrap GraphQLError to get the original resolver error for accurate error tags.
        resolverError = gqlError?.originalError || gqlError
      }
    }

    if (resolverError) {
      span.setTag('error', resolverError)
    } else if (!ctx.error && ctx.result && typeof ctx.result.then === 'function') {
      // For async resolvers, executeField returns a Promise. Resolver rejections
      // are caught internally by executeField's .then(undefined, handler) and added
      // to exeContext.errors/collectedErrors. The promise itself resolves (to null),
      // so we observe resolution and check if new errors were added.
      // Capture the refs in locals so the .then() closure doesn't retain ctx.
      ctx.result.then(() => {
        const errorsNow = getErrorCount(exeContext)
        if (errorsNow > errorCountBefore) {
          const gqlError = getErrorAt(exeContext, errorsNow - 1)
          const origError = gqlError?.originalError || gqlError
          if (origError) {
            span.setTag('error', origError)
          }
        }
      }, () => {})
    }

    // Update field error info if there was an error
    if (rootCtx && computedPathString && rootCtx.fields[computedPathString]) {
      const field = rootCtx.fields[computedPathString]
      if (resolverError) {
        field.error = resolverError
      }
      field.finishTime = span._getTime ? span._getTime() : 0
    }

    this.config.hooks.resolve(span, {
      fieldName,
      path: computedPathString,
      error: resolverError || null,
      result: ctx.result instanceof Promise ? undefined : ctx.result,
    })

    // Defer span.finish() to execute plugin's asyncEnd so all spans
    // are flushed in the same trace payload.
    const finishTime = span._getTime ? span._getTime() : 0
    if (executeSpan) {
      registerPendingResolveSpan(executeSpan, span, finishTime)
    } else {
      span.finish(finishTime)
    }

    return ctx.parentStore
  }

  configure (config) {
    super.configure(config.depth === 0 ? false : config)
  }
}

// Exported for execute.js to access
GraphQLResolvePlugin.execContextFields = execContextFields

function getFieldDef (schema, parentType, fieldNode) {
  const fieldName = fieldNode.name.value

  if (fieldName === '__schema' || fieldName === '__type' || fieldName === '__typename') {
    return
  }

  const fields = parentType.getFields?.()
  return fields?.[fieldName]
}

function shouldInstrument (config, path) {
  let depth = 0
  for (const item of path) {
    if (typeof item === 'string') {
      depth += 1
    }
  }

  return config.depth < 0 || config.depth >= depth
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

function getResolverArgs (fieldDef, fieldNode, variableValues) {
  if (!fieldNode.arguments || fieldNode.arguments.length === 0) return

  const args = {}
  for (const arg of fieldNode.arguments) {
    const name = arg.name?.value
    if (!name) continue

    if (arg.value?.kind === 'Variable') {
      const varName = arg.value.name?.value
      if (varName && variableValues) {
        args[name] = variableValues[varName]
      }
    } else if (arg.value?.value !== undefined) {
      args[name] = arg.value.value
    }
  }

  return Object.keys(args).length > 0 ? args : undefined
}

function getResolverInfo (info, args) {
  let resolverInfo = null
  const resolverVars = {}

  if (args) {
    Object.assign(resolverVars, args)
  }

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

function getParentField (parentCtx, lookupPath) {
  // lookupPath already matches the collapsed-form field keys used at insertion.
  for (let i = lookupPath.length - 1; i > 0; i--) {
    const key = lookupPath.slice(0, i).join('.')
    const field = parentCtx.fields[key]
    if (field) {
      return field
    }
  }

  return null
}

// Helpers for accessing execution errors across graphql versions.
// v0.10-v15.x: exeContext.errors (array)
// v16.x+: exeContext.collectedErrors._errors (array)
function getErrorsArray (exeContext) {
  if (exeContext.errors) return exeContext.errors
  if (exeContext.collectedErrors?._errors) return exeContext.collectedErrors._errors
}

function getErrorCount (exeContext) {
  const errors = getErrorsArray(exeContext)
  return errors ? errors.length : 0
}

function getErrorAt (exeContext, index) {
  const errors = getErrorsArray(exeContext)
  return errors ? errors[index] : undefined
}

module.exports = GraphQLResolvePlugin
