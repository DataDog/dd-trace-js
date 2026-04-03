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

    // Build info-like object from executeField arguments
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

    const computedPath = getPath(info, this.config)

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

    // Get parent field span for correct nesting
    const parentField = getParentField(rootCtx, pathToArray(path), this.config.collapse)
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
      const variables = this.config.variables(info.variableValues)

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

    // Stash for end handler
    ctx._ddInfo = info
    ctx._ddRootCtx = rootCtx
    ctx._ddComputedPathString = computedPathString
    ctx._ddSpanCreated = true
    ctx._ddExecuteSpan = rootCtx.executeSpan
    ctx._ddExeContext = exeContext
    ctx._ddErrorCountBefore = getErrorCount(exeContext)

    // Resolve arguments from the exeContext (field-level args)
    const resolverArgs = getResolverArgs(fieldDef, fieldNode, exeContext.variableValues)

    if (this.resolverStartCh.hasSubscribers) {
      const abortController = new AbortController()
      this.resolverStartCh.publish({ abortController, resolverInfo: getResolverInfo(info, resolverArgs) })
    }

    if (this.iastResolveCh.hasSubscribers) {
      this.iastResolveCh.publish({ rootCtx, args: resolverArgs, info, path: computedPath, pathString: computedPathString })
    }

    return ctx.currentStore
  }

  end (ctx) {
    if (!ctx._ddSpanCreated) return

    const span = ctx?.currentStore?.span || this.activeSpan
    if (!span) return

    // Detect resolver errors. executeField/resolveField catch resolver exceptions
    // internally (try-catch in graphql's execute.js), so the traceSync error channel
    // never fires. Instead, detect errors by checking if the error collection grew.
    let resolverError = ctx.error
    if (!resolverError && ctx._ddExeContext) {
      const exeContext = ctx._ddExeContext
      const errorsBefore = ctx._ddErrorCountBefore || 0
      const errorsNow = getErrorCount(exeContext)
      if (errorsNow > errorsBefore) {
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
      ctx.result.then(() => {
        const exeContext = ctx._ddExeContext
        if (exeContext) {
          const errorsNow = getErrorCount(exeContext)
          const errorsBefore = ctx._ddErrorCountBefore || 0
          if (errorsNow > errorsBefore) {
            const gqlError = getErrorAt(exeContext, errorsNow - 1)
            const origError = gqlError?.originalError || gqlError
            if (origError) {
              span.setTag('error', origError)
            }
          }
        }
      }, () => {})
    }

    // Update field error info if there was an error
    const rootCtx = ctx._ddRootCtx
    const pathString = ctx._ddComputedPathString
    if (rootCtx && pathString && rootCtx.fields[pathString]) {
      const field = rootCtx.fields[pathString]
      if (resolverError) {
        field.error = resolverError
      }
      field.finishTime = span._getTime ? span._getTime() : 0
    }

    this.config.hooks.resolve(span, {
      fieldName: ctx._ddInfo.fieldName,
      path: ctx._ddComputedPathString,
      error: resolverError || null,
      result: ctx.result instanceof Promise ? undefined : ctx.result,
    })

    // Defer span.finish() to execute plugin's asyncEnd so all spans
    // are flushed in the same trace payload.
    const finishTime = span._getTime ? span._getTime() : 0
    const executeSpan = ctx._ddExecuteSpan
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
    return undefined
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

function getPath (info, config) {
  const responsePathAsArray = config.collapse
    ? withCollapse(pathToArray)
    : pathToArray
  return responsePathAsArray(info.path)
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

function withCollapse (responsePathAsArray) {
  return function () {
    return responsePathAsArray.apply(this, arguments)
      .map(segment => typeof segment === 'number' ? '*' : segment)
  }
}

function getResolverArgs (fieldDef, fieldNode, variableValues) {
  if (!fieldNode.arguments || fieldNode.arguments.length === 0) return undefined

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

function getParentField (parentCtx, path, collapse) {
  // When collapse is enabled, field keys use '*' for numeric indices
  // (e.g., 'friends.*.pets'), so we must also collapse the lookup path.
  const lookupPath = collapse
    ? path.map(segment => typeof segment === 'number' ? '*' : segment)
    : path
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
  return undefined
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
