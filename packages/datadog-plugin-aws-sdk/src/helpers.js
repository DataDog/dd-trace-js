'use strict'

const Tags = require('opentracing').Tags

const services = {
  cloudwatchlogs: getService(require('./services/cloudwatchlogs')),
  dynamodb: getService(require('./services/dynamodb')),
  kinesis: getService(require('./services/kinesis')),
  lambda: getService(require('./services/lambda')),
  s3: getService(require('./services/s3')),
  redshift: getService(require('./services/redshift')),
  sns: getService(require('./services/sns')),
  sqs: getService(require('./services/sqs')),
  eventbridge: getService(require('./services/eventbridge'))
}

function getService (Service) {
  return new Service()
}

const helpers = {
  finish (span, err) {
    if (err) {
      span.setTag('error', err)

      if (err.requestId) {
        span.addTags({ 'aws.response.request_id': err.requestId })
      }
    }

    span.finish()
  },

  isEnabled (serviceIdentifier, config, request) {
    if (typeof config === 'boolean') {
      return config
    } else if (!config || typeof config !== 'object' || !services[serviceIdentifier]) {
      return true
    }

    return services[serviceIdentifier].isEnabled
      ? services[serviceIdentifier].isEnabled(config, request)
      : true
  },

  addResponseTags (span, response, serviceName, config) {
    if (!span) return

    if (response.request) {
      this.addServicesTags(span, response, serviceName)
    }

    config.hooks.request(span, response)
  },

  addServicesTags (span, response, serviceName) {
    if (!span) return

    const params = response.request.params
    const operation = response.request.operation
    const extraTags = services[serviceName] ? services[serviceName].generateTags(params, operation, response) : {}
    const tags = Object.assign({
      'aws.response.request_id': response.requestId,
      'resource.name': operation,
      'span.kind': 'client'
    }, extraTags)

    span.addTags(tags)
  },

  responseExtract (serviceName, request, response, tracer) {
    if (services[serviceName] && services[serviceName].responseExtract) {
      const params = request.params
      const operation = request.operation
      return services[serviceName].responseExtract(params, operation, response, tracer)
    }
  },

  requestInject (span, request, serviceName, tracer) {
    if (!span) return

    const inject = services[serviceName] && services[serviceName].requestInject
    if (inject) inject(span, request, tracer)
  },

  wrapCb (cb, serviceName, tags, request, tracer, childOf) {
    const awsHelpers = this
    return function wrappedCb (err, resp) {
      const maybeChildOf = awsHelpers.responseExtract(serviceName, request, resp, tracer)
      if (maybeChildOf) {
        const options = {
          childOf: maybeChildOf,
          tags: Object.assign({}, tags, { [Tags.SPAN_KIND]: 'server' })
        }
        return tracer.wrap('aws.response', options, cb).apply(this, arguments)
      } else {
        return tracer.scope().bind(cb, childOf).apply(this, arguments)
      }
    }
  }
}

module.exports = helpers
