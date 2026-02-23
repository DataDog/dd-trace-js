'use strict'

const dc = require('dc-polyfill')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const collapsedPathSym = Symbol('collapsedPaths')

class GraphQLResolvePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'resolve'

  start (field) {
    const { info, rootCtx, args, parentField } = field
    // FIXME - https://github.com/DataDog/dd-trace-js/issues/7468
    if (this.config.collapse) field.depth += getListLevel(info.path)
    if (!this.shouldInstrument(field)) return

    // we need to get the parent span to the field if it exists for correct span parenting
    // of nested fields
    const childOf = parentField?.currentStore?.span

    const path = getPath(info, this.config)
    const computedPathString = path.join('.')

    if (this.config.collapse) {
      if (!rootCtx[collapsedPathSym]) {
        rootCtx[collapsedPathSym] = {}
      } else if (rootCtx[collapsedPathSym][computedPathString]) {
        field.finishCtx = field
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
    }, field)
    // make this.finish(fieldCtx) be called before operation execution ends:
    field.finishCtx = field

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

    // return field.currentStore // seems unused? This is not `bindStart`!
  }

  constructor (...args) {
    super(...args)

    this.addTraceSub('updateField', (field) => {
      if (!this.shouldInstrument(field)) return

      const span = field?.currentStore?.span || this.activeSpan
      field.finishTime = span._getTime ? span._getTime() : 0
    })

    this.resolverStartCh = dc.channel('datadog:graphql:resolver:start')
    this.shouldInstrument = _field => false
  }

  configure (config) {
    // this will disable resolve subscribers if `config.depth` is set to 0
    super.configure(config.depth === 0 ? false : config)

    this.shouldInstrument = config.depth < 0
      ? _field => true
      : field => config.depth >= field.depth
  }

  finish (fieldCtx) {
    const { finishTime } = fieldCtx

    const span = fieldCtx?.currentStore?.span || this.activeSpan
    span.finish(finishTime)

    // return fieldCtx.parentStore
  }
}

// helpers

/** Count `*` chars in front of last path segment for a collapsed path */
function getListLevel (path) {
  let lvl = 0
  let curr = path.prev
  while (curr && typeof curr.key === 'number') {
    lvl++
    curr = curr.prev
  }
  return lvl
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
