const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analytisSampler = require('../../dd-trace/src/analytics_sampler')
const log = require('../../dd-trace/src/log')

class GraphQLPlugin extends Plugin {
  static get name () {
    return 'graphql'
  }

  constructor (...args) {
    super(...args)

    /** Execute Subs */

    /** Parser Subs */

    this.addSub('apm:graphql:parser:start', () => {
      const store = storage.getStore()
      const span = startSpan('parser', this.config, this.tracer, store)

      analytisSampler.sample(span, this.config.measured, true)
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

    this.addSub('apm:graphql:parser:error', err => {
      if (err) {
        const span = storage.getStore().span
        span.setTag('error', err)
      }
    })

    /** Validate Subs */

    this.addSub('apm:graphql:validate:start', ({ docSource, document }) => {
      const store = storage.getStore()
      const span = startSpan('validate', this.config, this.tracer, store)

      analytisSampler.sample(span, this.config.measured, true)

      if (document && document.loc) {
        const tags = {}
        if (this.config.source && document) {
          tags['graphql.source'] = docSource
        }

        span.addTags(tags)
      }
    })

    this.addSub('apm:graphql:validate:finish', ({ document, errors }) => {
      const span = storage.getStore().span
      this.config.hooks.validate(span, document, errors)
      span.finish()
    })

    this.addSub('apm:graphql:validate:error', err => {
      if (err) {
        const span = storage.getStore().span
        span.setTag('error', err)
      }
    })
  }

  configure (config) {
    return super.configure(validateConfig(config))
  }
}

function getService (tracer, config) {
  return config.service || tracer._service
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

function startSpan (name, conf, tracer, store) {
  const service = getService(tracer, conf)
  const childOf = store ? store.span : store
  const options = {}
  return tracer.startSpan(`graphql.${name}`, {
    childOf,
    startTime: options.startTime,
    tags: {
      'service.name': service,
      'span.type': 'graphql'
    }
  })
}

module.exports = GraphQLPlugin
