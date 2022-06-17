'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class GraphQLResolvePlugin extends Plugin {
  static get name () {
    return 'graphql'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:graphql:resolve:start', ({ info, context }) => {
      const store = storage.getStore()
      depthPredicate(info, this.config, (computedPath) => {
        if (!hasLikePath(context, computedPath)) {
          const service = this.config.service || this.tracer._service
          const childOf = store ? store.span : store
          const span = this.tracer.startSpan(`graphql.resolve`, {
            childOf: childOf,
            tags: {
              'service.name': service,
              'span.type': 'graphql'
            }
          })
          const document = context.source
          const fieldNode = info.fieldNodes.find(fieldNode => fieldNode.kind === 'Field')

          analyticsSampler.sample(span, this.config.measured)

          span.addTags({
            'resource.name': `${info.fieldName}:${info.returnType}`,
            'graphql.field.name': info.fieldName,
            'graphql.field.path': computedPath.join('.'),
            'graphql.field.type': info.returnType.name
          })

          if (fieldNode) {
            if (this.config.source && document && fieldNode.loc) {
              span.setTag('graphql.source', document.substring(fieldNode.loc.start, fieldNode.loc.end))
            }

            if (this.config.variables && fieldNode.arguments) {
              const variables = this.config.variables(info.variableValues)

              fieldNode.arguments
                .filter(arg => arg.value && arg.value.kind === 'Variable')
                .filter(arg => arg.value.name && variables[arg.value.name.value])
                .map(arg => arg.value.name.value)
                .forEach(name => {
                  span.setTag(`graphql.variables.${name}`, variables[name])
                })
            }
          }
          this.enter(span, store)
        }
      })
    })

    this.addSub('apm:graphql:resolve:updateField', ({ field, info, err }) => {
      depthPredicate(info, this.config, () => {
        const span = storage.getStore().span
        field.finishTime = span._getTime ? span._getTime() : 0
        field.error = field.error || err
      })
    })

    this.addSub('apm:graphql:resolve:finish', finishTime => {
      const span = storage.getStore().span
      span.finish(finishTime)
    })
  }
}

// helpers

/** This function is used for collapsed fields, where on the
 * instrumentation, we store fields by a default of config.collapse = false.
 * So, to avoid starting spans for properly computed paths that already have a span,
 * in the case of config.collapse = true, this function computes if there exits a path
 * that has already been processed for a span that either looks like or is the computed path.
 * In the case where the user intentionally sets config.collapse = false, there should be no change.
 */
function hasLikePath (context, computedPathArray) {
  const computedPath = computedPathArray.join('.')
  const paths = Object.keys(context.fields)
  const number = '([0-9]+)'
  const regexPath = new RegExp(computedPath.replace(/\*/g, number))
  return paths.filter(path => regexPath.test(path)).length > 0
}

function depthPredicate (info, config, func) {
  func = func || (() => {})
  const path = getPath(info, config)
  const depth = path.filter(item => typeof item === 'string').length
  if (config.depth < 0 || config.depth >= depth) func(path)
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

module.exports = GraphQLResolvePlugin
