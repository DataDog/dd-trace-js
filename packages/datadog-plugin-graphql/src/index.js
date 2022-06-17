'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const log = require('../../dd-trace/src/log')
const GraphQLResolvePlugin = require('./resolve')

let tools
class GraphQLPlugin extends Plugin {
  static get name () {
    return 'graphql'
  }

  constructor (...args) {
    super(...args)

    /** Execute Subs */

    // resolve plugin separated for disabling purposes
    this.resolve = new GraphQLResolvePlugin(...args)

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
    const validated = validateConfig(config)

    // this will disable resolve subscribers if `config.depth` is set to 0
    const resolveConfig = validated.depth === 0 ? false : validated
    this.resolve.configure(resolveConfig)

    return super.configure(validated)
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

function startSpan (name, conf, tracer, store, options) {
  const service = conf.service || tracer._service
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
