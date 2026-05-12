'use strict'

const dc = require('dc-polyfill')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const collapsedPathSym = Symbol('collapsedPaths')

class GraphQLResolvePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'resolve'

  start (fieldCtx) {
    const { info, rootCtx, args, path: pathAsArray, pathString } = fieldCtx

    // we need to get the parent span to the field if it exists for correct span parenting
    // of nested fields
    const parentField = getParentField(rootCtx, pathString)
    const childOf = parentField?.ctx?.currentStore?.span

    fieldCtx.parent = parentField

    if (!shouldInstrument(this.config, pathAsArray)) return
    const computedPathString = this.config.collapse
      ? buildCollapsedPathString(pathAsArray)
      : pathString

    if (this.config.collapse) {
      if (rootCtx.fields[computedPathString]) return

      if (!rootCtx[collapsedPathSym]) {
        rootCtx[collapsedPathSym] = Object.create(null)
      } else if (rootCtx[collapsedPathSym][computedPathString]) {
        return
      }

      rootCtx[collapsedPathSym][computedPathString] = true
    }

    const document = rootCtx.source
    const fieldNode = info.fieldNodes[0]
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
        'graphql.field.type': info.returnType.name,
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
      this.resolverStartCh.publish({ ctx: rootCtx, resolverInfo: getResolverInfo(info, args) })
    }

    return fieldCtx.currentStore
  }

  constructor (...args) {
    super(...args)

    this.addTraceSub('updateField', (ctx) => {
      const { field, error, path: pathAsArray } = ctx

      if (!shouldInstrument(this.config, pathAsArray)) return

      const span = ctx?.currentStore?.span || this.activeSpan
      field.finishTime = span._getTime ? span._getTime() : 0
      field.error = field.error || error
    })

    this.resolverStartCh = dc.channel('datadog:graphql:resolver:start')
  }

  configure (config) {
    // this will disable resolve subscribers if `config.depth` is set to 0
    super.configure(config.depth === 0 ? false : config)
  }

  finish (ctx) {
    const { finishTime } = ctx

    const span = ctx?.currentStore?.span || this.activeSpan
    span.finish(finishTime)

    return ctx.parentStore
  }
}

// helpers

function shouldInstrument (config, pathAsArray) {
  if (config.depth < 0) return true

  let depth = 0
  if (config.collapse) {
    depth = pathAsArray.length
  } else {
    for (const segment of pathAsArray) {
      if (typeof segment === 'string') depth += 1
    }
  }

  return config.depth >= depth
}

function buildCollapsedPathString (pathAsArray) {
  let result = ''
  for (const segment of pathAsArray) {
    if (result.length > 0) result += '.'
    result += typeof segment === 'number' ? '*' : segment
  }
  return result
}

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

function getParentField (parentCtx, pathToString) {
  let current = pathToString

  while (current) {
    const lastJoin = current.lastIndexOf('.')
    if (lastJoin === -1) break

    current = current.slice(0, lastJoin)
    const field = parentCtx.fields[current]

    if (field) return field
  }

  return null
}

module.exports = GraphQLResolvePlugin
