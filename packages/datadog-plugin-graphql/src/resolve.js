'use strict'

const dc = require('dc-polyfill')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const collapsedPathSym = Symbol('collapsedPaths')

class GraphQLResolvePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'resolve'

  // Uses the default apm:graphql:resolve prefix via TracingPlugin, subscribing
  // automatically to :start and :finish. We add an explicit :updateField handler.

  constructor (...args) {
    super(...args)

    this.resolverStartCh = dc.channel('datadog:graphql:resolver:start')

    // updateField fires from the wrapped resolver's callback in execute.js.
    // Used to capture per-field error + finishTime before finishResolvers runs.
    this.addTraceSub('updateField', (fieldCtx) => {
      const { field, error, info } = fieldCtx

      const path = getPath(this.config, fieldCtx.path)
      if (!shouldInstrument(this.config, path)) return

      const span = fieldCtx?.currentStore?.span || this.activeSpan
      field.finishTime = span?._getTime ? span._getTime() : 0
      field.error = field.error || error || extractErrorFromInfo(info)
    })
  }

  start (fieldCtx) {
    const { info, rootCtx, args } = fieldCtx

    const path = getPath(this.config, fieldCtx.path)
    const parentField = getParentField(rootCtx, fieldCtx.pathString)
    fieldCtx.parent = parentField
    const childOf = parentField?.ctx?.currentStore?.span

    if (!shouldInstrument(this.config, path)) return

    const computedPathString = path.join('.')

    if (this.config.collapse) {
      if (rootCtx.fields[computedPathString] && rootCtx.fields[computedPathString] !== fieldCtx) return

      if (!rootCtx[collapsedPathSym]) {
        rootCtx[collapsedPathSym] = Object.create(null)
      } else if (rootCtx[collapsedPathSym][computedPathString]) {
        return
      }

      rootCtx[collapsedPathSym][computedPathString] = true
    }

    const document = rootCtx.source
    const fieldNode = info.fieldNodes?.find(fn => fn.kind === 'Field')
    const loc = this.config.source && document && fieldNode && fieldNode.loc
    const source = loc && document.slice(loc.start, loc.end)

    const span = this.startSpan('graphql.resolve', {
      service: this.config.service,
      resource: `${info.fieldName}:${info.returnType}`,
      childOf,
      type: 'graphql',
      meta: {
        'graphql.field.name': info.fieldName,
        'graphql.field.path': computedPathString,
        'graphql.field.type': info.returnType?.name,
        'graphql.source': source,
      },
    }, fieldCtx)

    if (fieldNode && this.config.variables && fieldNode.arguments) {
      const variables = this.config.variables(info.variableValues)

      for (const arg of fieldNode.arguments) {
        if (arg.value?.name && arg.value.kind === 'Variable' && variables[arg.value.name.value]) {
          const name = arg.value.name.value
          span.setTag(`graphql.variables.${name}`, variables[name])
        }
      }
    }

    if (this.resolverStartCh.hasSubscribers) {
      this.resolverStartCh.publish({
        abortController: rootCtx.abortController,
        resolverInfo: getResolverInfo(info, args),
      })
    }

    return fieldCtx.currentStore
  }

  finish (fieldCtx) {
    const { finishTime } = fieldCtx

    const span = fieldCtx?.currentStore?.span || this.activeSpan
    if (!span) return

    this.config.hooks.resolve(span, {
      fieldName: fieldCtx.info?.fieldName,
      path: fieldCtx.pathString,
      error: fieldCtx.field?.error || null,
      result: fieldCtx.result instanceof Promise ? undefined : fieldCtx.result,
    })

    if (fieldCtx.field?.error) {
      span.setTag('error', fieldCtx.field.error)
    }

    // Finish directly — matches master. The deferred-finish path (state.js) is
    // retained only for cases where we can't reach here, e.g. synchronous error
    // paths where execute plugin's _drain runs before this handler.
    const resolvedFinishTime = finishTime || (span._getTime ? span._getTime() : 0)
    span.finish(resolvedFinishTime)

    return fieldCtx.parentStore
  }

  configure (config) {
    // Setting depth: 0 disables the resolve plugin entirely.
    super.configure(config.depth === 0 ? false : config)
  }
}

function shouldInstrument (config, path) {
  let depth = 0
  for (const item of path) {
    if (typeof item === 'string') depth += 1
  }
  return config.depth < 0 || config.depth >= depth
}

function getPath (config, pathAsArray) {
  if (!config.collapse) return pathAsArray
  return pathAsArray.map(segment => typeof segment === 'number' ? '*' : segment)
}

function getParentField (rootCtx, pathString) {
  let current = pathString
  while (current) {
    const last = current.lastIndexOf('.')
    if (last === -1) break
    current = current.slice(0, last)
    const field = rootCtx.fields[current]
    if (field) return field
  }
  return null
}

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

// Fallback error extraction: graphql v16+ stores per-field errors on exeContext
// rather than propagating them through the resolver callback. If the updateField
// callback got called with err=null but info has an attached error, surface it.
function extractErrorFromInfo (info) {
  const exeContext = info?._exeContext || info?.context
  const errors = exeContext?.errors || exeContext?.collectedErrors?._errors
  if (!errors || !errors.length) return null
  const last = errors[errors.length - 1]
  return last?.originalError || last
}

module.exports = GraphQLResolvePlugin
