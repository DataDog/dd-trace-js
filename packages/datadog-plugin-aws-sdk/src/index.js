'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const awsHelpers = require('./helpers')

function createWrapRequest (tracer, config) {
  config = normalizeConfig(config)
  return function wrapRequest (send) {
    return function requestWithTrace (cb) {
      if (!this.service) return send.apply(this, arguments)

      const serviceIdentifier = this.service.serviceIdentifier

      if (!awsHelpers.isEnabled(serviceIdentifier, config[serviceIdentifier], this)) {
        return send.apply(this, arguments)
      }

      const serviceName = getServiceName(serviceIdentifier, tracer, config)
      const childOf = tracer.scope().active()
      const tags = {
        [Tags.SPAN_KIND]: 'client',
        'service.name': serviceName,
        'aws.operation': this.operation,
        'aws.region': this.service.config && this.service.config.region,
        'aws.service': this.service.api && this.service.api.className,
        'component': 'aws-sdk'
      }

      const span = tracer.startSpan('aws.request', {
        childOf,
        tags
      })

      this.on('complete', response => {
        if (!span) return

        awsHelpers.addResponseTags(span, response, serviceIdentifier, config, tracer)
        awsHelpers.finish(config, span, response, response.error)
      })

      analyticsSampler.sample(span, config.measured)

      awsHelpers.requestInject(span, this, serviceIdentifier, tracer)

      const request = this

      return tracer.scope().activate(span, () => {
        if (typeof cb === 'function') {
          arguments[0] = awsHelpers.wrapCb(cb, serviceIdentifier, tags, request, tracer, childOf)
        }
        return send.apply(this, arguments)
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
      this.unwrap(AWS.Request.prototype, 'send')
    }
  }
]
