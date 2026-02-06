'use strict'

const dc = require('dc-polyfill')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const collapsedPathSym = Symbol('collapsedPaths')

class GraphQLResolvePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'resolve'

  start (fieldCtx) {
    const { info, rootCtx, args, parentField } = fieldCtx

    // we need to get the parent span to the field if it exists for correct span parenting
    // of nested fields
    const childOf = parentField?.currentStore?.span

    const path = getPath(info, this.config)
    if (!shouldInstrument(this.config, path)) return
    const computedPathString = path.join('.')

    if (this.config.collapse) {
      if (!rootCtx[collapsedPathSym]) {
        rootCtx[collapsedPathSym] = {}
      } else if (rootCtx[collapsedPathSym][computedPathString]) {
        return
      }

      rootCtx[collapsedPathSym][computedPathString] = true
    }

    const document = rootCtx.source
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

  constructor (...args) {
    super(...args)

    this.addTraceSub('updateField', (fieldCtx) => {
      const path = getPath(fieldCtx.info, this.config)

      if (!shouldInstrument(this.config, path)) return

      const span = fieldCtx?.currentStore?.span || this.activeSpan
      fieldCtx.finishTime = span._getTime ? span._getTime() : 0
    })

    this.resolverStartCh = dc.channel('datadog:graphql:resolver:start')
  }

  configure (config) {
    // this will disable resolve subscribers if `config.depth` is set to 0
    super.configure(config.depth === 0 ? false : config)
  }

  finish (fieldCtx) {
    const { finishTime } = fieldCtx

    const span = fieldCtx?.currentStore?.span || this.activeSpan
    span.finish(finishTime)

    return fieldCtx.parentStore
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
  const path = pathToArray(info.path)
  return config.collapse
    ? collapsePath(path)
    : path
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

function collapsePath (pathArray) {
  return pathArray.map(segment => typeof segment === 'number' ? '*' : segment)
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

module.exports = GraphQLResolvePlugin
