'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const log = require('../../dd-trace/src/log')

let tools
class GraphQLPlugin extends Plugin {
  static get name () {
    return 'graphql'
  }

  constructor (...args) {
    super(...args)

    /** Execute Subs */

    this.addSub('apm:graphql:execute:start', (config) => {
      config.config = this.config
    })

    this.addSub('apm:graphql:resolve:updateField', ({ field, info, err }) => {
      depthPredicate(info, this.config, () => {
        const span = storage.getStore().span
        field.finishTime = span._getTime ? span._getTime() : 0
        field.error = field.error || err
      })
    })

    this.addSub('apm:graphql:resolve:start', ({ info, context }) => {
      const store = storage.getStore()
      depthPredicate(info, this.config, (computedPath) => {
        if (!hasLikePath(context, computedPath)) {
          startResolveSpan(store, info, computedPath, context, this.config, this.tracer, this.enter)
        }
      })
    })

    this.addSub('apm:graphql:execute:start', ({ operation, args, docSource }) => {
      const store = storage.getStore()
      const span = startSpan('execute', this.config, this.tracer, store)

      // process add tags
      addExecutionTags(span, this.config, operation, args.document)
      addDocumentTags(span, args.document, this.config, docSource)
      addVariableTags(this.config, span, args.variableValues)

      analyticsSampler.sample(span, this.config.measured, true)

      this.enter(span, store)
    })

    this.addSub('apm:graphql:execute:error', this.addError)

    this.addSub('apm:graphql:execute:finish', ({ res, args }) => {
      const span = storage.getStore().span
      this.config.hooks.execute(span, args, res)
      span.finish()
    })

    this.addSub('apm:graphql:resolve:finish', finishTime => {
      const span = storage.getStore().span
      span.finish(finishTime)
    })

    /** Parser Subs */

    this.addSub('apm:graphql:parser:start', () => {
      const store = storage.getStore()
      const span = startSpan('parse', this.config, this.tracer, store)

      analyticsSampler.sample(span, this.config.measured, true)
      this.enter(span, store)
    })

    this.addSub('apm:graphql:parser:finish', ({ source, document, docSource }) => {
      const span = storage.getStore().span

      const tags = {}
      if (this.config.source && document) {
        tags['graphql.source'] = docSource
      }

      span.addTags(tags)

      this.config.hooks.parse(span, source, document)

      span.finish()
    })

    this.addSub('apm:graphql:parser:error', this.addError)

    /** Validate Subs */

    this.addSub('apm:graphql:validate:start', ({ docSource, document }) => {
      const store = storage.getStore()
      const span = startSpan('validate', this.config, this.tracer, store)

      analyticsSampler.sample(span, this.config.measured, true)

      if (document && document.loc) {
        const tags = {}
        if (this.config.source && document) {
          tags['graphql.source'] = docSource
        }

        span.addTags(tags)
      }

      this.enter(span, store)
    })

    this.addSub('apm:graphql:validate:finish', ({ document, errors }) => {
      const span = storage.getStore().span
      this.config.hooks.validate(span, document, errors)
      span.finish()
    })

    this.addSub('apm:graphql:validate:error', this.addError)
  }

  configure (config) {
    return super.configure(validateConfig(config))
  }
}

// general helpers

function getService (tracer, config) {
  return config.service || tracer._service
}

/** This function is used for collapsed fields, where on the
 * instrumentation, we store fields by a default of config.collapse = false.
 * So, to avoid starting spans for properly computed paths that already have a span,
 * in the case of config.collapse = true, this function computes if there exits a path
 * that has already been processed for a span that either looks like or is the computed path.
 * In the case where the user intentionally sets config.collapse = false, there should be no change.
 */
function hasLikePath (context, computedPath) {
  const paths = Object.keys(context.fields)
  const number = '([0-9]+)'
  const regexPath = new RegExp(computedPath.join('.').replaceAll('*', number))
  return paths.filter(path => regexPath.test(path)).length > 0
}

function getPath (info, config) {
  const responsePathAsArray = config.collapse
    ? withCollapse(pathToArray)
    : pathToArray
  return responsePathAsArray(info && info.path)
}

function depthPredicate (info, config, func) {
  func = func || (() => {})
  const path = getPath(info, config)
  const depth = path.filter(item => typeof item === 'string').length
  if (config.depth < 0 || config.depth >= depth) func(path)
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

// config validator helpers

function validateConfig (config) {
  return Object.assign({}, config, {
    depth: getDepth(config),
    variables: getVariablesFilter(config),
    collapse: config.collapse === undefined || !!config.collapse,
    hooks: getHooks(config)
  })
}

function getDepth (config) {
  if (typeof config.depth === 'number') {
    return config.depth
  } else if (config.hasOwnProperty('depth')) {
    log.error('Expected `depth` to be a integer.')
  }
  return -1
}

function getVariablesFilter (config) {
  if (typeof config.variables === 'function') {
    return config.variables
  } else if (config.variables instanceof Array) {
    return variables => pick(variables, config.variables)
  } else if (config.hasOwnProperty('variables')) {
    log.error('Expected `variables` to be an array or function.')
  }
  return null
}

function getHooks (config) {
  const noop = () => { }
  const execute = (config.hooks && config.hooks.execute) || noop
  const parse = (config.hooks && config.hooks.parse) || noop
  const validate = (config.hooks && config.hooks.validate) || noop

  return { execute, parse, validate }
}

// non-lodash pick

function pick (obj, selectors) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => selectors.includes(key)))
}

// span-related

function startResolveSpan (store, info, path, context, config, tracer, enter) {
  const span = startSpan('resolve', config, tracer, store)
  const document = context.source
  const fieldNode = info.fieldNodes.find(fieldNode => fieldNode.kind === 'Field')

  analyticsSampler.sample(span, config.measured)

  span.addTags({
    'resource.name': `${info.fieldName}:${info.returnType}`,
    'graphql.field.name': info.fieldName,
    'graphql.field.path': path.join('.'),
    'graphql.field.type': info.returnType.name
  })

  if (fieldNode) {
    if (config.source && document && fieldNode.loc) {
      span.setTag('graphql.source', document.substring(fieldNode.loc.start, fieldNode.loc.end))
    }

    if (config.variables && fieldNode.arguments) {
      const variables = config.variables(info.variableValues)

      fieldNode.arguments
        .filter(arg => arg.value && arg.value.kind === 'Variable')
        .filter(arg => arg.value.name && variables[arg.value.name.value])
        .map(arg => arg.value.name.value)
        .forEach(name => {
          span.setTag(`graphql.variables.${name}`, variables[name])
        })
    }
  }
  enter(span, store)
}

function startSpan (name, conf, tracer, store, options) {
  const service = getService(tracer, conf)
  const childOf = store ? store.span : store
  options = options || {}
  return tracer.startSpan(`graphql.${name}`, {
    childOf: options.childOf || childOf,
    startTime: options.startTime,
    tags: {
      'service.name': service,
      'span.type': 'graphql'
    }
  })
}

function addExecutionTags (span, config, operation, document) {
  const type = operation && operation.operation
  const name = operation && operation.name && operation.name.value
  const tags = {
    'resource.name': getSignature(document, name, type, config.signature)
  }

  if (type) {
    tags['graphql.operation.type'] = type
  }

  if (name) {
    tags['graphql.operation.name'] = name
  }

  span.addTags(tags)
}

function addDocumentTags (span, document, config, docSource) {
  const tags = {}

  if (config.source && document) {
    tags['graphql.source'] = docSource
  }

  span.addTags(tags)
}

function addVariableTags (config, span, variableValues) {
  const tags = {}

  if (variableValues && config.variables) {
    const variables = config.variables(variableValues)
    for (const param in variables) {
      tags[`graphql.variables.${param}`] = variables[param]
    }
  }

  span.addTags(tags)
}

function getSignature (document, operationName, operationType, calculate) {
  if (calculate !== false && tools !== false) {
    try {
      try {
        tools = tools || require('./tools')
      } catch (e) {
        tools = false
        throw e
      }

      return tools.defaultEngineReportingSignature(document, operationName)
    } catch (e) {
      // safety net
    }
  }

  return [operationType, operationName].filter(val => val).join(' ')
}

module.exports = GraphQLPlugin
