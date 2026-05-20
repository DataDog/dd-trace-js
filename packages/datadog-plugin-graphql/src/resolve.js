'use strict'

const dc = require('dc-polyfill')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class GraphQLResolvePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'resolve'

  /**
   * @param {{
   *   rootCtx: {
   *     source?: string,
   *     collapse: boolean,
   *     collapsedFields?: Map<string, { ctx: object }>,
   *   },
   *   args: Record<string, unknown>,
   *   path: { prev: object | undefined, key: string | number },
   *   pathString: string,
   *   fieldName: string,
   *   returnType: { name: string },
   *   fieldNode: { loc?: { start: number, end: number }, arguments?: object[], directives?: object[] } | undefined,
   *   variableValues: Record<string, unknown> | undefined,
   * }} fieldCtx
   */
  start (fieldCtx) {
    if (!shouldInstrument(this.config, fieldCtx.path)) return

    const { rootCtx, args, path, pathString, fieldName, returnType, fieldNode, variableValues } = fieldCtx

    // Siblings 2..N of a collapsed list share the first sibling's span, so
    // skip span creation here. updateField still fires on the shared ctx and
    // advances the shared span's finishTime.
    if (rootCtx.collapse && rootCtx.collapsedFields?.has(pathString)) return

    const parentField = getParentField(rootCtx, path)
    const childOf = parentField?.ctx?.currentStore?.span

    const document = rootCtx.source
    const loc = this.config.source && document && fieldNode && fieldNode.loc
    const source = loc && document.slice(loc.start, loc.end)

    const span = this.startSpan('graphql.resolve', {
      service: this.config.service,
      resource: `${fieldName}:${returnType}`,
      childOf,
      type: 'graphql',
      meta: {
        'graphql.field.name': fieldName,
        'graphql.field.path': pathString,
        'graphql.field.type': returnType.name,
        'graphql.source': source,
      },
    }, fieldCtx)

    if (fieldNode && this.config.variables && fieldNode.arguments) {
      const variables = this.config.variables(variableValues)

      for (const arg of fieldNode.arguments) {
        if (arg.value?.name && arg.value.kind === 'Variable' && variables[arg.value.name.value]) {
          const name = arg.value.name.value
          span.setTag(`graphql.variables.${name}`, variables[name])
        }
      }
    }

    if (this.resolverStartCh.hasSubscribers) {
      this.resolverStartCh.publish({ ctx: rootCtx, resolverInfo: getResolverInfo(fieldNode, fieldName, args) })
    }

    return fieldCtx.currentStore
  }

  constructor (...args) {
    super(...args)

    this.addTraceSub('updateField', (ctx) => {
      // start short-circuited on the depth gate, so there is no span to advance.
      if (ctx.currentStore === undefined) return

      const { field, error } = ctx
      const span = ctx.currentStore.span
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

/**
 * @param {{ depth: number, collapse: boolean }} config
 * @param {{ prev: object | undefined, key: string | number }} path
 */
function shouldInstrument (config, path) {
  const depth = config.depth
  if (depth < 0) return true

  let count = 0
  if (config.collapse) {
    for (let curr = path; curr; curr = curr.prev) count += 1
  } else {
    for (let curr = path; curr; curr = curr.prev) {
      if (typeof curr.key === 'string') count += 1
    }
  }
  return depth >= count
}

/**
 * @param {object | undefined} fieldNode
 * @param {string} fieldName
 * @param {Record<string, unknown> | undefined} args
 */
function getResolverInfo (fieldNode, fieldName, args) {
  let resolverVars

  if (args && Object.keys(args).length > 0) {
    resolverVars = { ...args }
  }

  const directives = fieldNode?.directives
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

  return resolverVars === undefined ? null : { [fieldName]: resolverVars }
}

/**
 * @param {{ fields: Map<object, { error: unknown, ctx: object }> }} rootCtx
 * @param {{ prev: object | undefined }} path
 */
function getParentField (rootCtx, path) {
  for (let curr = path.prev; curr; curr = curr.prev) {
    const field = rootCtx.fields.get(curr)
    if (field) return field
  }
}

module.exports = GraphQLResolvePlugin
