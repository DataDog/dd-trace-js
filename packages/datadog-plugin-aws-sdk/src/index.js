'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const awsHelpers = require('./helpers')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const { AsyncResource } = require('../../datadog-instrumentations/src/helpers/instrument')

const requestTags = new WeakMap()

class AwsSdkPlugin extends Plugin {
  static get name () {
    return 'aws-sdk'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:aws:request:start', ({ request, serviceIdentifier, operation, awsRegion, awsService }) => {
      if (!awsHelpers.isEnabled(serviceIdentifier, this.config[serviceIdentifier], request)) {
        return
      }
      const serviceName = getServiceName(serviceIdentifier, this.tracer, this.config)
      const childOf = this.tracer.scope().active()
      const tags = {
        [Tags.SPAN_KIND]: 'client',
        'service.name': serviceName,
        'aws.operation': operation,
        'aws.region': awsRegion,
        'aws.service': awsService,
        'component': 'aws-sdk'
      }
      requestTags.set(request, tags)

      const span = this.tracer.startSpan('aws.request', { childOf, tags })

      analyticsSampler.sample(span, this.config.measured)

      awsHelpers.requestInject(span, request, serviceIdentifier, this.tracer)

      const store = storage.getStore()

      this.enter(span, store)
    })

    this.addSub('apm:aws:request:complete', ({ response, serviceIdentifier }) => {
      const store = storage.getStore()
      if (!store) return
      const { span } = store
      if (!span) return
      awsHelpers.addResponseTags(span, response, serviceIdentifier)
      awsHelpers.finish(this.config, span, response, response.error)
    })

    this.addSub('apm:aws:response', obj => {
      const { request, response, serviceName } = obj
      const store = storage.getStore()
      const plugin = this
      const maybeChildOf = awsHelpers.responseExtract(serviceName, request, response, this.tracer)
      if (maybeChildOf) {
        const options = {
          childOf: maybeChildOf,
          tags: Object.assign({}, requestTags.get(request) || {}, { [Tags.SPAN_KIND]: 'server' })
        }
        obj.ar = {
          real: new AsyncResource('apm:aws:response'),
          runInAsyncScope (fn) {
            return this.real.runInAsyncScope(() => {
              const span = plugin.tracer.startSpan('aws.response', options)
              plugin.enter(span, store)
              try {
                let result = fn()
                if (result && result.then) {
                  result = result.then(x => {
                    span.finish()
                    return x
                  }, e => {
                    span.setTag(e)
                    throw e
                  })
                } else {
                  span.finish()
                }
                return result
              } catch (e) {
                span.setTag(e)
                span.finish()
              }
            })
          }
        }
      }
    })
  }

  configure (config) {
    Plugin.prototype.configure.call(this, config)
    this.config = normalizeConfig(config)
  }
}

function normalizeConfig (config) {
  const hooks = getHooks(config)

  return Object.assign({}, config, {
    splitByAwsService: config.splitByAwsService !== false,
    hooks
  })
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

// TODO: test splitByAwsService when the test suite is fixed
function getServiceName (serviceIdentifier, tracer, config) {
  return config.service
    ? config.service
    : `${tracer._service}-aws-${serviceIdentifier}`
}

module.exports = AwsSdkPlugin
