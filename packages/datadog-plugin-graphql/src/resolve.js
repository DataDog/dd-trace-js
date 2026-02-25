'use strict'

const dc = require('dc-polyfill')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class GraphQLResolvePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'resolve'

  start (field) {
    const { info, rootCtx, args, parentField } = field
    // FIXME - https://github.com/DataDog/dd-trace-js/issues/7468
    if (this.config.collapse) field.depth += getListLevel(info.path)
    if (!this.shouldInstrument(field)) return

    let childOf, path, ctx

    if (this.config.collapse) {
      const parent = parentField?.shared
      const sharedContexts = parentField
        ? parent.collapsedChildren
        : (rootCtx.toplevelCollapsed ??= {})
      ctx = sharedContexts[info.fieldName]
      if (ctx) {
        // Add reference to the shared context object,
        // for the `finish` subscription to store the `.finishTime` on
        // and for children resolvers to find `.collapsedChildren`.
        field.shared = ctx
        this.enter(ctx.currentStore.span) // TODO: test this!
        return
      }
      childOf = parent ? parent.currentStore?.span : undefined
      path = collapsePath(pathToArray(info.path))
      // create shared context
      ctx = sharedContexts[info.fieldName] = {
        fieldName: info.fieldName,
        path,
        parent,
        finishTime: 0,
        collapsedChildren: {}, // slightly pointless on leaf fields?
        // more to be added by `startSpan`
      }
      field.shared = ctx
      // make `field.finalize()` be called before operation execution ends:
      field.finalize = finalizeCollapsedField
    } else {
      childOf = parentField ? parentField.currentStore?.span : undefined
      path = pathToArray(info.path)
      ctx = field
    }

    const docSource = rootCtx.docSource
    const fieldNode = info.fieldNodes.find(fieldNode => fieldNode.kind === 'Field') // FIXME: https://github.com/graphql/graphql-js/issues/605#issuecomment-266160864
    const loc = this.config.source && docSource && fieldNode && fieldNode.loc
    const source = loc && docSource.slice(loc.start, loc.end)

    const span = this.startSpan('graphql.resolve', {
      service: this.config.service,
      resource: `${info.fieldName}:${info.returnType}`,
      childOf, // span used by parent field (if it exists) for correct span parenting of nested fields
      type: 'graphql',
      meta: {
        'graphql.field.name': info.fieldName,
        'graphql.field.path': path.join('.'),
        'graphql.field.type': info.returnType.name,
        'graphql.source': source,
      },
    }, ctx)

    if (fieldNode && this.config.variables && fieldNode.arguments) {
      const variables = this.config.variables(info.variableValues)

      for (const { value: argValue } of fieldNode.arguments) {
        if (argValue.kind === 'Variable') {
          const varName = argValue.name.value
          if (variables[varName] != null) {
            span.setTag(`graphql.variables.${varName}`, variables[varName])
          }
        }
      }
    }

    if (this.resolverStartCh.hasSubscribers) {
      this.resolverStartCh.publish({
        abortController: rootCtx.abortController,
        resolverInfo: getResolverInfo(info, args),
      })
    }

    // return ctx.currentStore // seems unused? This is not `bindStart`!
  }

  finish (field) {
    if (!this.shouldInstrument(field)) return

    if (this.config.collapse) {
      const fieldCtx = field.shared
      const span = fieldCtx.currentStore?.span
      if (field.error) {
        fieldCtx.error ??= field.error
        // TODO: use `extractErrorIntoSpanEvent`
      }
      fieldCtx.finishTime = span._getTime ? span._getTime() : 0
      this.config.hooks.resolve(span, field)
    } else {
      const span = field.currentStore?.span
      this.config.hooks.resolve(span, field)
      span?.finish()
    }
  }

  constructor (...args) {
    super(...args)

    this.resolverStartCh = dc.channel('datadog:graphql:resolver:start')
    this.shouldInstrument = _field => false

    this.addTraceSub('finalize', field => {
      field.finalize()
    })
  }

  configure (config) {
    // this will disable resolve subscribers if `config.depth` is set to 0
    super.configure(config.depth === 0 ? false : config)

    this.shouldInstrument = config.depth < 0
      ? _field => true
      : field => config.depth >= field.depth
  }
}

// helpers

/** The method that is put as `.finalize` on a field when a shared context is created */
function finalizeCollapsedField () {
  const { shared } = this
  const span = shared.currentStore?.span
  if (shared.error) { // an error from any of the fields (that failed first)
    span.setTag('error', shared.error) // like `TracingPlugin.prototype.error(shared)`
  }
  span?.finish(shared.finishTime)
}

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
