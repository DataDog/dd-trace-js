'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const awsHelpers = require('./aws_helpers')

function createWrapRequest (tracer, config) {
  return function wrapRequest (request) {
    return function requestWithTrace (operation, params, cb) {
      const serviceName = awsHelpers.normalizeServiceName(this)
      // look how ruby/java are defining these details
      let baseTags = {
        [Tags.SPAN_KIND]: 'client',
        'span.type': 'http',
        'service.name': config.service || `${tracer._service}-aws`,
        'resource.name': `${serviceName}_${operation}`,
        'aws.agent': 'js-aws-sdk',
        'aws.operation': operation,
        'aws.region': request.httpRequest && request.httpRequest.region || this.config.region,
        'aws.service': serviceName,
        'component': serviceName
      }

      const childOf = tracer.scope().active()
      const span = tracer.startSpan('aws.http', {
        childOf,
        tags: baseTags
      })

      analyticsSampler.sample(span, config.analytics)

      if (typeof cb === 'function') {
        return tracer.scope().activate(span, () => {
          return request.call(this, operation, params, awsHelpers.wrapCallback(tracer, span, cb, childOf, this))
         }) 
      } else {
        
        const awsRequest = request.apply(this, arguments)

        awsRequest.on('send', function(response) {
          tracer.scope().activate(span)
        })

        awsRequest.on('complete', function(response) {
          if(response.requestId) {
            span.addTags('aws.requestId', response.requestId)
          }

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

      // console.log('trying to patch', AWS.Service, AWS.Service.prototype)

      this.wrap(AWS.Service.prototype, 'makeRequest', createWrapRequest(tracer, config))
    },
    unpatch (Transport) {
      this.unwrap(AWS.Service.prototype, 'makeRequest')
    }
  }
]
