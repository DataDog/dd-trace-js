'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const awsHelpers = require('./helpers')

function createWrapRequest (tracer, config) {
  config = normalizeConfig(config)

  return function wrapRequest (send) {
    return function requestWithTrace (cb) {
      if (!this.service) return send.apply(this, arguments)

      const serviceName = this.service.serviceIdentifier
      const childOf = tracer.scope().active()
      const tags = {
        [Tags.SPAN_KIND]: 'client',
        'service.name': config.service
          ? `${config.service}-aws-${serviceName}`
          : `${tracer._service}-aws-${serviceName}`,
        'aws.operation': this.operation,
        'aws.region': this.service.config && this.service.config.region,
        'aws.service': this.service.api && this.service.api.className,
        'component': 'aws-sdk'
      }

      const span = tracer.startSpan('aws.request', {
        childOf,
        tags
      })

      const boundCb = typeof cb === 'function' ? tracer.scope().bind(cb, childOf) : cb

      this.on('complete', response => {
        if (!span) return

        awsHelpers.addResponseTags(span, response, serviceName, config)
        awsHelpers.finish(span, response.error)
      })

      analyticsSampler.sample(span, config.analytics)

      return tracer.scope().activate(span, () => {
        return send.call(this, boundCb)
      })
    }
  }
}

function createWrapSetPromisesDependency (tracer, config, instrumenter, AWS) {
  return function wrapSetPromisesDependency (setPromisesDependency) {
    return function setPromisesDependencyWithTrace (dep) {
      const result = setPromisesDependency.apply(this, arguments)

      instrumenter.wrap(AWS.Request.prototype, 'promise', createWrapRequest(tracer, config))

      return result
    }
  }
}

function normalizeConfig (config) {
  const hooks = getHooks(config)

  return Object.assign({}, config, {
    hooks
  })
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

// <2.1.35 has breaking changes for instrumentation
// https://github.com/aws/aws-sdk-js/pull/629
module.exports = [
  {
    name: 'aws-sdk',
    versions: ['>=2.3.0'],
    patch (AWS, tracer, config) {
      this.wrap(AWS.Request.prototype, 'promise', createWrapRequest(tracer, config))
      this.wrap(AWS.config, 'setPromisesDependency', createWrapSetPromisesDependency(tracer, config, this, AWS))
    },
    unpatch (AWS) {
      this.unwrap(AWS.Request.prototype, 'promise')
      this.unwrap(AWS.config, 'setPromisesDependency')
    }
  },
  {
    name: 'aws-sdk',
    versions: ['>=2.1.35'],
    patch (AWS, tracer, config) {
      this.wrap(AWS.Request.prototype, 'send', createWrapRequest(tracer, config))
    },
    unpatch (AWS) {
      this.wrap(AWS.Request.prototype, 'send')
    }
  }
]
