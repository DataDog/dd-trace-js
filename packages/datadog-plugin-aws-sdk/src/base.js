'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const awsHelpers = require('./aws_helpers')

function createWrapRequest (tracer, config) {
  return function wrapRequest (request) {
    return function requestWithTrace (operation, params, cb) {
      const serviceName = awsHelpers.normalizeServiceName(this)

      // TODO: should tablename/streamname/etc be part of resurce?
      const baseTags = {
        [Tags.SPAN_KIND]: 'client',
        'span.type': 'http',
        'service.name': config.service || `${tracer._service}-aws`,
        'aws.agent': 'js-aws-sdk',
        'aws.operation': operation,
        'aws.region': (request.httpRequest && request.httpRequest.region) || this.config.region,
        'aws.service': serviceName,
        'component': serviceName
      }

      const childOf = tracer.scope().active()
      const span = tracer.startSpan('aws.http', {
        childOf,
        tags: baseTags
      })

      // sync with serverless on how to normalize to fit existing conventions
      // <operation>_<specialityvalue>
      awsHelpers.addResourceAndSpecialtyTags(span, operation, params)

      analyticsSampler.sample(span, config.analytics)

      if (typeof cb === 'function') {
        return tracer.scope().activate(span, () => {
          return request.call(this, operation, params, awsHelpers.wrapCallback(tracer, span, cb, childOf))
        })
      } else {
        const awsRequest = request.apply(this, arguments)

        awsRequest.on('send', response => {
          tracer.scope().activate(span)
        })

        awsRequest.on('complete', response => {
          awsHelpers.addAdditionalTags(span, response)
          awsHelpers.finish(span, response.error)
        })

        return awsRequest
      }
    }
  }
}

// function quantizePath (path) {
//   return path && path.replace(/[0-9]+/g, '?')
// }

module.exports = [
  {
    name: 'aws-sdk',
    versions: ['>=2.0'],
    patch (AWS, tracer, config) {
      this.wrap(AWS.Service.prototype, 'makeRequest', createWrapRequest(tracer, config))
    },
    unpatch (AWS) {
      this.unwrap(AWS.Service.prototype, 'makeRequest')
    }
  }
]
