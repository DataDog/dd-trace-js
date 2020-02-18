'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const awsHelpers = require('./aws_helpers')

function createWrapRequest (tracer, config) {
  config = normalizeConfig(config)

  return function wrapRequest (request) {
    return function requestWithTrace (operation, params, cb) {
      const serviceName = awsHelpers.normalizeServiceName(this)

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

      awsHelpers.addAwsRequestTags(span, request, operation, params, serviceName)

      analyticsSampler.sample(span, config.analytics)

      // https://github.com/awsdocs/aws-javascript-developer-guide-v2/blob/
      // master/doc_source/using-a-callback-function.md#using-an-anonymous-callback-function
      if (typeof cb === 'function') {
        return tracer.scope().activate(span, () => {
          return request.call(this, operation, params, awsHelpers.wrapCallback(tracer, span, cb, childOf, config))
        })
      } else {
        const awsReq = request.apply(this, arguments)
        const boundAwsReq = tracer.scope().bind(awsReq, span)

        boundAwsReq.on('send', response => {
          tracer.scope().activate(span)
        })

        // https://github.com/awsdocs/aws-javascript-developer-guide-v2/blob/
        // master/doc_source/using-a-response-event-handler.md#the-complete-event
        boundAwsReq.on('complete', response => {
          // response is same AWS.Response object
          // as https://github.com/aws/aws-sdk-js/issues/781#issuecomment-156250427
          awsHelpers.addAwsResponseTags(span, response)
          config.hooks.addCustomTags(span, params)
          awsHelpers.finish(span, response.error, config)
        })

        return boundAwsReq
      }
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
  const addCustomTags = (config.hooks && config.hooks.addCustomTags) || noop

  return { addCustomTags }
}

module.exports = [
  {
    name: 'aws-sdk',
    versions: ['>=2.3.0'],
    patch (AWS, tracer, config) {
      this.wrap(AWS.Service.prototype, 'makeRequest', createWrapRequest(tracer, config))
    },
    unpatch (AWS) {
      this.unwrap(AWS.Service.prototype, 'makeRequest')
    }
  }
]
