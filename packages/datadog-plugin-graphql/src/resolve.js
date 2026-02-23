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

    // we need to get the parent span to the field if it exists for correct span parenting
    // of nested fields
    const childOf = parentField ? this.getFieldContext(parentField).currentStore?.span : undefined

    let path, ctx
    if (this.config.collapse) {
      const sharedContexts = parentField
        ? parentField.shared.collapsedChildren
        : (rootCtx.toplevelCollapsed ??= {})
      ctx = sharedContexts[info.fieldName]
      if (ctx) {
        // Add reference to the shared context object,
        // for the `updateField` to store the `.finishTime` on
        // and for children resolvers to find `.collapsedChildren`.
        // Should not be `finish`ed again and again though, so we don't use .finishCtx`
        field.shared = ctx
        this.enter(ctx.currentStore.span) // TODO: test this!
        return
      }
      path = collapsePath(pathToArray(info.path))
      // create shared context
      ctx = sharedContexts[info.fieldName] = {
        fieldName: info.fieldName,
        path,
        parent: parentField?.shared,
        finishTime: 0,
        collapsedChildren: {}, // slightly pointless on leaf fields?
        // more to be added by `startSpan`
      }
      field.shared = ctx
      // make this.finish(fieldCtx) be called before operation execution ends:
      field.finishCtx = ctx
    } else {
      path = pathToArray(info.path)
      ctx = field
      // make this.finish(fieldCtx) be called before operation execution ends:
      // and also to receive events when there's an `.error` on them
      field.finishCtx = field
    }

    const document = rootCtx.source
    const fieldNode = info.fieldNodes.find(fieldNode => fieldNode.kind === 'Field') // FIXME: https://github.com/graphql/graphql-js/issues/605#issuecomment-266160864
    const loc = this.config.source && document && fieldNode && fieldNode.loc
    const source = loc && document.slice(loc.start, loc.end)

    const span = this.startSpan('graphql.resolve', {
      service: this.config.service,
      resource: `${info.fieldName}:${info.returnType}`,
      childOf,
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

  constructor (...args) {
    super(...args)

    this.addTraceSub('updateField', (field) => {
      if (!this.shouldInstrument(field)) return

      const fieldCtx = this.getFieldContext(field)
      const span = fieldCtx.currentStore?.span || this.activeSpan
      fieldCtx.finishTime = span._getTime ? span._getTime() : 0

      if (this.config.collapse && field.error) {
        // the `field.shared` context is used to publish `error` events in `finishResolvers` :-/
        // FIXME: this should probably use `extractErrorIntoSpanEvent`
        fieldCtx.error ??= field.error // notice the first error wins (like in `validate` and `execute`)
      }

      this.config.hooks.resolve(span, field)
    })

    this.resolverStartCh = dc.channel('datadog:graphql:resolver:start')
    this.shouldInstrument = _field => false
    this.getFieldContext = _field => null
  }

  configure (config) {
    // this will disable resolve subscribers if `config.depth` is set to 0
    super.configure(config.depth === 0 ? false : config)

    this.shouldInstrument = config.depth < 0
      ? _field => true
      : field => config.depth >= field.depth
    this.getFieldContext = config.collapse
      ? field => field.shared
      : field => field
  }

  finish ({ finishTime, currentStore }) {
    const span = currentStore?.span // no `|| this.activeSpan`, which might be anything
    if (!span) return
    // we care only about the span that was opened for the respective context
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
