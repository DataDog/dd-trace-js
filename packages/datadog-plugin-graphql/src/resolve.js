'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const dc = require('dc-polyfill')

const collapsedPathSym = Symbol('collapsedPaths')

class GraphQLResolvePlugin extends TracingPlugin {
  static get id () { return 'graphql' }
  static get operation () { return 'resolve' }

  start (fieldCtx) {
    const { info, ctx: parentCtx, args } = fieldCtx

    const path = getPath(info, this.config)

    // we need to get the parent span to the field if it exists for correct span parenting
    // of nested fields
    const parentField = getParentField(parentCtx, pathToArray(info && info.path))
    const childOf = parentField?.ctx?.currentStore?.span

    fieldCtx.parent = parentField

    if (!shouldInstrument(this.config, path)) return
    const computedPathString = path.join('.')

    if (this.config.collapse) {
      if (parentCtx.fields[computedPathString]) return

      if (!parentCtx[collapsedPathSym]) {
        parentCtx[collapsedPathSym] = {}
      } else if (parentCtx[collapsedPathSym][computedPathString]) {
        return
      }

      parentCtx[collapsedPathSym][computedPathString] = true
    }

    const document = parentCtx.source
    const fieldNode = info.fieldNodes.find(fieldNode => fieldNode.kind === 'Field')
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
        'graphql.source': source
      }
    }, fieldCtx)

    if (fieldNode && this.config.variables && fieldNode.arguments) {
      const variables = this.config.variables(info.variableValues)

      fieldNode.arguments
        .filter(arg => arg.value?.name && arg.value.kind === 'Variable' && variables[arg.value.name.value])
        .forEach(arg => {
          const name = arg.value.name.value
          span.setTag(`graphql.variables.${name}`, variables[name])
        })
    }

    if (this.resolverStartCh.hasSubscribers) {
      this.resolverStartCh.publish({ ctx: parentCtx, resolverInfo: getResolverInfo(info, args) })
    }

    return fieldCtx.currentStore
  }

  constructor (...args) {
    super(...args)

    this.addTraceSub('updateField', (ctx) => {
      const { field, info, error } = ctx

      const path = getPath(info, this.config)

      if (!shouldInstrument(this.config, path)) return

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
  return responsePathAsArray(info && info.path)
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

  if (hasResolvers || args && Object.keys(resolverVars).length) {
    resolverInfo = { [info.fieldName]: resolverVars }
  }

  return resolverInfo
}

function getParentField (parentCtx, path) {
  for (let i = path.length - 1; i > 0; i--) {
    const field = getField(parentCtx, path.slice(0, i))
    if (field) {
      return field
    }
  }

  return null
}

function getField (parentCtx, path) {
  return parentCtx.fields[path.join('.')]
}

module.exports = GraphQLResolvePlugin
